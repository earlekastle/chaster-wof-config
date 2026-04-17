// ==UserScript==
// @name         Chaster Wheel of Fortune Config Import/Export
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds import/export buttons to the Wheel of Fortune modal on chaster.app. Allows you to back up a current config to a .JSON file, and import any .JSON configs.
// @author       earlekastle
// @match        https://chaster.app/*
// @updateURL    https://github.com/earlekastle/chaster-wof-config/raw/refs/heads/main/script.user.js
// @downloadURL  https://github.com/earlekastle/chaster-wof-config/raw/refs/heads/main/script.user.js
// @grant        none
// @icon         https://chaster.app/favicon.png
// ==/UserScript==

(function() {
	'use strict';

	/*
	 * Constants
	 */

	const INJECT_MARKER = 'wof-config-injected';
	const DURATION_TYPES = new Set(['add-time', 'remove-time', 'add-remove-time', 'pillory']);

	/*
	 * Duration helpers
	 */

	function parseDurationLabel(label) {
		const d = { days: 0, hours: 0, minutes: 0 };
		if (!label) return d;
		const dm = label.match(/(\d+)\s+day/);
		const hm = label.match(/(\d+)\s+hour/);
		const mm = label.match(/(\d+)\s+minute/);
		if (dm) d.days = parseInt(dm[1], 10);
		if (hm) d.hours = parseInt(hm[1], 10);
		if (mm) d.minutes = parseInt(mm[1], 10);
		return d;
	}

	// Drive a NodeList of .DurationSelectorItem spinners to { days, hours, minutes }
	async function applyDurationToItems(items, target) {
		const units = ['days', 'hours', 'minutes'];
		for (let i = 0; i < items.length && i < units.length; i++) {
			const item = items[i];
			const goal = target[units[i]] ?? 0;
			const digits = item.querySelectorAll('.duration-digit');
			if (digits.length < 2) continue;
			const current = parseInt(digits[0].textContent + digits[1].textContent, 10) || 0;
			const addBtn = item.querySelector('button[aria-label^="Add"]');
			const remBtn = item.querySelector('button[aria-label^="Remove"]');
			if (!addBtn || !remBtn) continue;
			const delta = goal - current;
			const btn = delta > 0 ? addBtn : remBtn;
			for (let c = 0; c < Math.abs(delta); c++) {
				realClick(btn);
				await sleep(30);
			}
		}
	}

	async function resetDurationSpinners(items) {
		for (const item of items) {
			const digits = item.querySelectorAll('.duration-digit');
			if (digits.length < 2) continue;
			const current = parseInt(digits[0].textContent + digits[1].textContent, 10) || 0;
			const remBtn = item.querySelector('button[aria-label^="Remove"]');
			if (!remBtn || current === 0) continue;
			for (let c = 0; c < current; c++) {
				realClick(remBtn);
				await sleep(30);
			}
		}
	}

	// Wait for #popover-duration-selector to appear in the document
	async function waitForDurationPopover(timeout = 3000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const el = document.getElementById('popover-duration-selector');
			if (el) return el;
			await sleep(50);
		}
		console.warn('WoF: #popover-duration-selector did not appear within timeout');
		return null;
	}

	// Wait for #popover-duration-selector to disappear (after confirm click)
	async function waitForPopoverGone(timeout = 3000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (!document.getElementById('popover-duration-selector')) return true;
			await sleep(50);
		}
		return false;
	}

	// The popover has no explicit confirm button — clicking outside or pressing
	// Escape closes it. We close it by clicking the pencil link again (toggle),
	// or by dispatching a click on document.body outside the popover.
	async function closeDurationPopover() {
		// Click somewhere neutral to dismiss the popover
		document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await waitForPopoverGone();
	}

	/*
	 * Read modal state
	 */

	function readModalState(modal) {
		const config = {
			mode: null,
			regularity: { days: 0, hours: 0, minutes: 0 },
			segments: [],
		};

		// Mode
		const checkedMode = modal.querySelector('input[type="radio"]:checked');
		if (checkedMode) config.mode = checkedMode.id.replace('mode-', '');

		// Regularity — scoped to the .DurationSelector inside .d-sm-flex
		const regularitySelector = modal.querySelector('.d-sm-flex .DurationSelector');
		if (regularitySelector) {
			const items = regularitySelector.querySelectorAll('.DurationSelectorItem');
			['days', 'hours', 'minutes'].forEach((unit, i) => {
				const digits = items[i]?.querySelectorAll('.duration-digit');
				if (digits?.length === 2) {
					config.regularity[unit] = parseInt(digits[0].textContent + digits[1].textContent, 10) || 0;
				}
			});
		}

		// Segments
		modal.querySelectorAll('.card-content').forEach((row, i) => {
			const typeSelect = row.querySelector(`select[name="segments[${i}].type"]`);
			if (!typeSelect) return;
			const type = typeSelect.value;
			const seg = { type };

			if (type === 'text') {
				const textInput = row.querySelector(`input[name="segments[${i}].text"]`);
				seg.text = textInput ? textInput.value : '';
			} else if (DURATION_TYPES.has(type)) {
				const link = row.querySelector('.dotted-link');
				const rawText = link ?
					(link.childNodes[0]?.textContent?.trim() ?? link.textContent.replace(/\s+/g, ' ').trim()) :
					null;
				seg.duration = parseDurationLabel(rawText);
			}

			config.segments.push(seg);
		});

		return config;
	}

	/*
	 * Apply config
	 */

	async function applyConfigToModal(modal, config, statusEl) {
		setStatus(statusEl, '⏳ Applying config…');

		// Mode
		if (config.mode) {
			const radio = modal.querySelector(`#mode-${config.mode}`);
			if (radio) radio.click();
		}

		// Regularity — scoped to .d-sm-flex
		if (config.regularity) {
			const regularitySelector = modal.querySelector('.d-sm-flex .DurationSelector');
			if (regularitySelector) {
				const items = regularitySelector.querySelectorAll('.DurationSelectorItem');
				await applyDurationToItems(items, config.regularity);
			}
		}

		// Segments
		if (config.segments?.length > 0) {
			await applySegments(modal, config.segments, statusEl);
		}

		setStatus(statusEl, '✅ Done!');
		setTimeout(() => setStatus(statusEl, ''), 3000);
	}

	async function applySegments(modal, segments, statusEl) {
		setStatus(statusEl, '🗑 Clearing existing segments…');
		await clearAllSegments(modal);

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			setStatus(statusEl, `⚙️ Segment ${i + 1} / ${segments.length}: ${seg.type}…`);

			// Add a new row
			const addBtn = [...modal.querySelectorAll('button')]
				.find(b => b.textContent.trim().includes('Add an action'));
			if (!addBtn) { console.warn('WoF: Add button not found'); break; }
			addBtn.click();
			const appeared = await waitForSegmentRow(modal, i);
			if (!appeared) { console.warn(`WoF: row ${i} never appeared`); continue; }

			// Set type
			const typeSelect = modal.querySelector(`select[name="segments[${i}].type"]`);
			if (!typeSelect) continue;
			setNativeSelectValue(typeSelect, seg.type);
			await sleep(150); // let React re-render extras

			if (seg.type === 'text') {
				const textInput = modal.querySelector(`input[name="segments[${i}].text"]`);
				if (textInput) {
					setNativeInputValue(textInput, seg.text ?? '');
					await sleep(50);
				}

			} else if (DURATION_TYPES.has(seg.type) && seg.duration) {
				// Click the pencil to open the popover
				const row = typeSelect.closest('.card-content');
				const pencilLink = row?.querySelector('.dotted-link');
				if (!pencilLink) continue;

				pencilLink.click();
				const popover = await waitForDurationPopover();
				if (!popover) continue;

				const spinners = popover.querySelectorAll('.DurationSelectorItem');
				await resetDurationSpinners(spinners);
				await applyDurationToItems(spinners, seg.duration);

				// Close the popover by clicking outside it
				await closeDurationPopover();
			}
			// freeze/set-freeze/set-unfreeze: nothing more to do
		}
	}

	async function clearAllSegments(modal) {
		let safety = 300;
		while (safety-- > 0) {
			const trashIcon = modal.querySelector('.fa-trash-alt');
			if (!trashIcon) break;
			const trashBtn = trashIcon.closest('span.text-link') ?? trashIcon.closest('button');
			if (!trashBtn) break;
			trashBtn.click();
			await sleep(80);
		}
		await sleep(100);
	}

	async function waitForSegmentRow(modal, index, timeout = 4000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (modal.querySelector(`select[name="segments[${index}].type"]`)) return true;
			await sleep(50);
		}
		return false;
	}

	/*
	 * React-safe setters
	 */

	function fireEvents(el) {
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
	}

	function setNativeInputValue(input, value) {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
		setter ? setter.call(input, value) : (input.value = value);
		fireEvents(input);
	}

	function setNativeSelectValue(select, value) {
		const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
		setter ? setter.call(select, value) : (select.value = value);
		fireEvents(select);
	}

	/*
	 * Utilities
	 */

	function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

	function setStatus(el, msg) { if (el) el.textContent = msg; }

	function realClick(el) {
		el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
		el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	}

	/*
	 * Toolbar
	 */

	function buildToolbar(modal) {
		const toolbar = document.createElement('div');
		toolbar.id = INJECT_MARKER;
		toolbar.style.cssText = `
			display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
			padding: 10px 12px; margin-bottom: 12px;
			background: rgba(255,255,255,0.05);
			border: 1px solid rgba(255,255,255,0.12);
			border-radius: 30px; font-size: 16px; font-weight: 400;
		`;

		const statusEl = document.createElement('span');
		statusEl.style.cssText = 'font-size: 16px; order: 99;';

		const exportBtn = makeButton('Export JSON', '#171A1C', 'Download current config as a JSON file');
		exportBtn.addEventListener('click', () => {
			const blob = new Blob([JSON.stringify(readModalState(modal), null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = Object.assign(document.createElement('a'), { href: url, download: 'WheelConfig.json' });
			a.click();
			URL.revokeObjectURL(url);
		});

		const importBtn = makeButton('Import JSON', '#6D7DD1', 'Import a WheelConfig.json and fully apply it');
		importBtn.addEventListener('click', () => {
			const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
			input.addEventListener('change', async () => {
				const file = input.files[0];
				if (!file) return;
				try {
					await applyConfigToModal(modal, JSON.parse(await file.text()), statusEl);
				} catch (e) {
					alert('Failed to parse JSON: ' + e.message);
				}
			});
			input.click();
		});

		toolbar.append(exportBtn, importBtn, statusEl);
		return toolbar;
	}

	function makeButton(label, color, title = '') {
		const btn = document.createElement('button');
		Object.assign(btn, { textContent: label, type: 'button', title });
		btn.style.cssText = `
			background: ${color}; color: #fff; border: none;
			border-radius: 999px; padding: 6px 12px;
			font-size: 16px; font-weight: 400; cursor: pointer;
			white-space: nowrap; transition: opacity 0.15s;
		`;
		btn.addEventListener('mouseenter', () => (btn.style.opacity = '0.8'));
		btn.addEventListener('mouseleave', () => (btn.style.opacity = '1'));
		return btn;
	}

	// ─── Modal observer ───────────────────────────────────────────────────────────

	function tryInject() {
		document.querySelectorAll('.modal-title').forEach(title => {
			if (!title.textContent.includes('Wheel of Fortune')) return;
			const modal = title.closest('.modal-content');
			if (!modal || modal.querySelector(`#${INJECT_MARKER}`)) return;
			const hrs = modal.querySelectorAll('hr');
			const anchor = hrs[1] ?? hrs[0];
			if (!anchor) return;
			anchor.parentNode.insertBefore(buildToolbar(modal), anchor.nextSibling);
		});
	}

	new MutationObserver(tryInject).observe(document.body, { childList: true, subtree: true });
	tryInject();

})();
