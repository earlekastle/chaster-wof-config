// ==UserScript==
// @name         Chaster Wheel of Fortune Config Import/Export + Custom Colors
// @namespace    http://tampermonkey.net/
// @version      2.9
// @description  Adds import/export buttons, per-slice color pickers, and drag-and-drop reordering to the Wheel of Fortune modal on chaster.app, makes the wheel canvas render those colors, correctly sizes/centers the slice text, makes the wheel responsive to its container at higher resolution for crisp HDPI rendering, and replaces Chaster's stand/pointer background image with a small CSS pointer overlapping the wheel.
// @author       earlekastle (color support added on top locally)
// @match        https://chaster.app/*
// @match        https://*.chaster.app/*
// @run-at       document-start
// @grant        none
// @icon         https://chaster.app/favicon.png
// ==/UserScript==

// This is a local fork of earlekastle's chaster-wof-config script with slice
// color support merged in. The original @updateURL/@downloadURL have been
// removed on purpose: an auto-update from the upstream repo would silently
// overwrite everything below and drop the color feature. If you want to
// pick up future upstream changes, check the repo manually and re-merge.

(function () {
	"use strict";

	// @grant none is required here on purpose. It runs this script in the
	// page's own JS realm instead of a sandbox, which is the only way the
	// CanvasRenderingContext2D patch further down can actually affect the
	// page's own canvas draws.

	/*
	 * Constants
	 */

	const INJECT_MARKER = "wof-config-injected";
	const DURATION_TYPES = new Set(["add-time", "remove-time", "add-remove-time", "pillory"]);
	const COLOR_STORAGE_KEY = "wof-slice-colors-v1";
	const DEFAULT_SWATCH = "#cccccc";

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

	// Converts a raw duration in seconds (the shape the live API actually
	// uses) into the same { days, hours, minutes } shape parseDurationLabel
	// produces from the modal, so both sides of the color lookup agree.
	function secondsToDHM(totalSeconds) {
		totalSeconds = Math.round(totalSeconds || 0);
		const days = Math.floor(totalSeconds / 86400);
		let rem = totalSeconds % 86400;
		const hours = Math.floor(rem / 3600);
		rem %= 3600;
		const minutes = Math.floor(rem / 60);
		return { days, hours, minutes };
	}

	// Drive a NodeList of .DurationSelectorItem spinners to { days, hours, minutes }
	async function applyDurationToItems(items, target) {
		const units = ["days", "hours", "minutes"];
		for (let i = 0; i < items.length && i < units.length; i++) {
			const item = items[i];
			const goal = target[units[i]] ?? 0;
			const digits = item.querySelectorAll(".duration-digit");
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
			const digits = item.querySelectorAll(".duration-digit");
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
			const el = document.getElementById("popover-duration-selector");
			if (el) return el;
			await sleep(50);
		}
		console.warn("WoF: #popover-duration-selector did not appear within timeout");
		return null;
	}

	// Wait for #popover-duration-selector to disappear (after confirm click)
	async function waitForPopoverGone(timeout = 3000) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (!document.getElementById("popover-duration-selector")) return true;
			await sleep(50);
		}
		return false;
	}

	// The popover has no explicit confirm button, clicking outside or pressing
	// Escape closes it. We close it by dispatching a click on document.body
	// outside the popover.
	async function closeDurationPopover() {
		document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await waitForPopoverGone();
	}

	/*
	 * Segment identity, shared by the modal reader, the JSON import/export,
	 * and the canvas color override, so all three agree on what counts as
	 * "the same segment". Segments have no id in Chaster's data model, so
	 * this is the closest thing to one.
	 */

	function extractSegmentFromRow(row, index) {
		const typeSelect = row.querySelector(`select[name="segments[${index}].type"]`);
		if (!typeSelect) return null;
		const type = typeSelect.value;
		const seg = { type };

		if (type === "text") {
			const textInput = row.querySelector(`input[name="segments[${index}].text"]`);
			seg.text = textInput ? textInput.value : "";
		} else if (DURATION_TYPES.has(type)) {
			const link = row.querySelector(".dotted-link");
			const rawText = link
				? link.childNodes[0]?.textContent?.trim() ?? link.textContent.replace(/\s+/g, " ").trim()
				: null;
			seg.duration = parseDurationLabel(rawText);
		}

		return seg;
	}

	// Normalizes a raw segment straight from the API (duration in seconds,
	// if present) into the same shape extractSegmentFromRow produces.
	function normalizeApiSegment(raw) {
		if (!raw) return null;
		const seg = { type: raw.type };
		if (raw.type === "text") {
			seg.text = raw.text || "";
		} else if (DURATION_TYPES.has(raw.type)) {
			seg.duration = secondsToDHM(raw.duration);
		}
		return seg;
	}

	function segmentIdentity(seg) {
		if (!seg) return "";
		if (seg.type === "text") return seg.type + "::" + (seg.text || "");
		if (DURATION_TYPES.has(seg.type)) {
			const d = seg.duration || { days: 0, hours: 0, minutes: 0 };
			return seg.type + "::" + d.days + "d" + d.hours + "h" + d.minutes + "m";
		}
		// freeze / set-freeze / set-unfreeze: type alone. Two identical
		// freeze-type rows on the same wheel will share a color, that's fine.
		return seg.type;
	}

	/*
	 * Color persistence
	 */

	function loadColors() {
		try {
			return JSON.parse(localStorage.getItem(COLOR_STORAGE_KEY)) || {};
		} catch (e) {
			return {};
		}
	}

	function saveColors(colors) {
		localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(colors));
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
		if (checkedMode) config.mode = checkedMode.id.replace("mode-", "");

		// Regularity, scoped to the .DurationSelector inside .d-sm-flex
		const regularitySelector = modal.querySelector(".d-sm-flex .DurationSelector");
		if (regularitySelector) {
			const items = regularitySelector.querySelectorAll(".DurationSelectorItem");
			["days", "hours", "minutes"].forEach((unit, i) => {
				const digits = items[i]?.querySelectorAll(".duration-digit");
				if (digits?.length === 2) {
					config.regularity[unit] = parseInt(digits[0].textContent + digits[1].textContent, 10) || 0;
				}
			});
		}

		// Segments
		const colors = loadColors();
		modal.querySelectorAll(".card-content").forEach((row, i) => {
			const seg = extractSegmentFromRow(row, i);
			if (!seg) return;
			const color = colors[segmentIdentity(seg)];
			if (color) seg.color = color;
			config.segments.push(seg);
		});

		return config;
	}

	/*
	 * Apply config
	 */

	async function applyConfigToModal(modal, config, statusEl) {
		setStatus(statusEl, "\u23f3 Applying config\u2026");

		// Mode
		if (config.mode) {
			const radio = modal.querySelector(`#mode-${config.mode}`);
			if (radio) radio.click();
		}

		// Regularity, scoped to .d-sm-flex
		if (config.regularity) {
			const regularitySelector = modal.querySelector(".d-sm-flex .DurationSelector");
			if (regularitySelector) {
				const items = regularitySelector.querySelectorAll(".DurationSelectorItem");
				await applyDurationToItems(items, config.regularity);
			}
		}

		// Segments
		if (config.segments?.length > 0) {
			await applySegments(modal, config.segments, statusEl);
		}

		setStatus(statusEl, "\u2705 Done!");
		setTimeout(() => setStatus(statusEl, ""), 3000);
	}

	async function applySegments(modal, segments, statusEl) {
		setStatus(statusEl, "\ud83d\uddd1 Clearing existing segments\u2026");
		await clearAllSegments(modal);

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			setStatus(statusEl, `\u2699\ufe0f Segment ${i + 1} / ${segments.length}: ${seg.type}\u2026`);

			// Add a new row
			const addBtn = [...modal.querySelectorAll("button")].find((b) => b.textContent.trim().includes("Add an action"));
			if (!addBtn) {
				console.warn("WoF: Add button not found");
				break;
			}
			addBtn.click();
			const appeared = await waitForSegmentRow(modal, i);
			if (!appeared) {
				console.warn(`WoF: row ${i} never appeared`);
				continue;
			}

			// Set type
			const typeSelect = modal.querySelector(`select[name="segments[${i}].type"]`);
			if (!typeSelect) continue;
			setNativeSelectValue(typeSelect, seg.type);
			await sleep(150); // let React re-render extras

			if (seg.type === "text") {
				const textInput = modal.querySelector(`input[name="segments[${i}].text"]`);
				if (textInput) {
					setNativeInputValue(textInput, seg.text ?? "");
					await sleep(50);
				}
			} else if (DURATION_TYPES.has(seg.type) && seg.duration) {
				// Click the pencil to open the popover
				const row = typeSelect.closest(".card-content");
				const pencilLink = row?.querySelector(".dotted-link");
				if (!pencilLink) continue;

				pencilLink.click();
				const popover = await waitForDurationPopover();
				if (!popover) continue;

				const spinners = popover.querySelectorAll(".DurationSelectorItem");
				await resetDurationSpinners(spinners);
				await applyDurationToItems(spinners, seg.duration);

				// Close the popover by clicking outside it
				await closeDurationPopover();
			}
			// freeze/set-freeze/set-unfreeze: nothing more to do

			// Colors: only set if this segment's JSON explicitly carries one.
			// Segments with no "color" key are left however they currently are,
			// importing an old export (or one without colors set) never wipes
			// out colors you've already picked for matching segments.
			if (seg.color) {
				const identity = segmentIdentity(seg);
				const colors = loadColors();
				colors[identity] = seg.color;
				saveColors(colors);

				const row = modal.querySelector(`select[name="segments[${i}].type"]`)?.closest(".card-content");
				const picker = row?.querySelector(".wof-color-picker");
				if (picker) picker.value = seg.color;
			}
		}
	}

	// Drag-and-drop reordering rebuilds the whole segment list the same way
	// Import JSON does (clear, then re-add each row in order), rather than
	// trying to move DOM nodes around by hand. That gets us type, text,
	// duration, and color all carried over for free, since applySegments
	// already knows how to restore all of that, we just need to hand it the
	// segments in the order we want.
	async function reorderSegments(modal, sourceIndex, destIndex) {
		if (sourceIndex === destIndex || Number.isNaN(sourceIndex) || Number.isNaN(destIndex)) return;
		const statusEl = modal.querySelector(".wof-status");
		const config = readModalState(modal);
		const segments = config.segments;
		if (sourceIndex < 0 || sourceIndex >= segments.length || destIndex < 0 || destIndex >= segments.length) return;
		const [moved] = segments.splice(sourceIndex, 1);
		segments.splice(destIndex, 0, moved);
		await applySegments(modal, segments, statusEl);
	}

	async function clearAllSegments(modal) {
		let safety = 300;
		while (safety-- > 0) {
			const trashIcon = modal.querySelector(".fa-trash-alt");
			if (!trashIcon) break;
			const trashBtn = trashIcon.closest("span.text-link") ?? trashIcon.closest("button");
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
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	}

	function setNativeInputValue(input, value) {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter ? setter.call(input, value) : (input.value = value);
		fireEvents(input);
	}

	function setNativeSelectValue(select, value) {
		const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
		setter ? setter.call(select, value) : (select.value = value);
		fireEvents(select);
	}

	/*
	 * Utilities
	 */

	function sleep(ms) {
		return new Promise((r) => setTimeout(r, ms));
	}

	function setStatus(el, msg) {
		if (el) el.textContent = msg;
	}

	function realClick(el) {
		el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
		el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	}

	/*
	 * Toolbar (export / import)
	 */

	function buildToolbar(modal) {
		const toolbar = document.createElement("div");
		toolbar.id = INJECT_MARKER;
		toolbar.style.cssText = `
			display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
			padding: 10px 12px; margin-bottom: 12px;
			background: rgba(255,255,255,0.05);
			border: 1px solid rgba(255,255,255,0.12);
			border-radius: 30px; font-size: 16px; font-weight: 400;
		`;

		const statusEl = document.createElement("span");
		statusEl.className = "wof-status";
		statusEl.style.cssText = "font-size: 16px; order: 99;";

		const exportBtn = makeButton("Export JSON", "#171A1C", "Download current config (including colors) as a JSON file");
		exportBtn.addEventListener("click", () => {
			const blob = new Blob([JSON.stringify(readModalState(modal), null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = Object.assign(document.createElement("a"), { href: url, download: "WheelConfig.json" });
			a.click();
			URL.revokeObjectURL(url);
		});

		const importBtn = makeButton("Import JSON", "#6D7DD1", "Import a WheelConfig.json and fully apply it, colors included");
		importBtn.addEventListener("click", () => {
			const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json" });
			input.addEventListener("change", async () => {
				const file = input.files[0];
				if (!file) return;
				try {
					await applyConfigToModal(modal, JSON.parse(await file.text()), statusEl);
				} catch (e) {
					alert("Failed to parse JSON: " + e.message);
				}
			});
			input.click();
		});

		const resetColorsBtn = makeButton("Reset colors", "#6D7DD1", "Clear every saved slice color override");
		resetColorsBtn.addEventListener("click", () => {
			if (!confirm("Clear all saved slice colors? This does not touch actions, durations, or text.")) return;
			saveColors({});
			modal.querySelectorAll(".wof-color-picker").forEach((picker) => (picker.value = DEFAULT_SWATCH));
		});

		toolbar.append(exportBtn, importBtn, resetColorsBtn, statusEl);
		return toolbar;
	}

	function makeButton(label, color, title = "") {
		const btn = document.createElement("button");
		Object.assign(btn, { textContent: label, type: "button", title });
		btn.style.cssText = `
			background: ${color}; color: #fff; border: none;
			border-radius: 999px; padding: 6px 12px;
			font-size: 16px; font-weight: 400; cursor: pointer;
			white-space: nowrap; transition: opacity 0.15s;
		`;
		btn.addEventListener("mouseenter", () => (btn.style.opacity = "0.8"));
		btn.addEventListener("mouseleave", () => (btn.style.opacity = "1"));
		return btn;
	}

	/*
	 * Color pickers, one per segment row
	 */

	function injectPickerStyles() {
		if (document.getElementById("wof-color-picker-styles")) return;
		const style = document.createElement("style");
		style.id = "wof-color-picker-styles";
		style.textContent = `
			.wof-color-picker-wrap {
				display: inline-flex;
				align-items: center;
				gap: 4px;
				margin-right: 8px;
			}
			.wof-color-picker {
				width: 28px;
				height: 28px;
				padding: 0;
				border: none;
				border-radius: 50%;
				cursor: pointer;
				background: none;
			}
			.wof-color-reset {
				cursor: pointer;
				opacity: 0.6;
				font-size: 12px;
				background: none;
				border: none;
				color: inherit;
			}
			.wof-color-reset:hover {
				opacity: 1;
			}
			.wof-drag-handle {
				cursor: grab;
				padding: 0 8px;
				opacity: 0.5;
				user-select: none;
				font-size: 14px;
				line-height: 1;
			}
			.wof-drag-handle:hover {
				opacity: 1;
			}
			.wof-dragging {
				opacity: 0.4;
			}
			.wof-drop-target {
				border-top: 2px solid #6d7dd1;
			}
		`;
		document.head.appendChild(style);
	}

	function injectColorPickers(modal) {
		injectPickerStyles();

		modal.querySelectorAll(".card-content").forEach((row, i) => {
			const seg = extractSegmentFromRow(row, i);
			if (!seg) return;

			const colors = loadColors();
			const identity = segmentIdentity(seg);
			const swatchColor = colors[identity] || DEFAULT_SWATCH;

			const existingWrap = row.querySelector(".wof-color-picker-wrap");
			if (existingWrap) {
				// The row already has a picker. Shuffle actions (and anything
				// else that reorders segments without adding/removing DOM
				// nodes) leaves this picker physically in place while the
				// row's underlying action changes, so re-sync its displayed
				// value to whatever now actually lives in this row. Skip it
				// while the user has the native color popup focused so we
				// don't fight their in-progress pick.
				const picker = existingWrap.querySelector(".wof-color-picker");
				if (picker && document.activeElement !== picker) {
					picker.value = swatchColor;
				}
				return;
			}

			const anchor = row.querySelector(".actions.ml-2.mr-2");
			if (!anchor) return;

			const wrap = document.createElement("div");
			wrap.className = "wof-color-picker-wrap";

			const picker = document.createElement("input");
			picker.type = "color";
			picker.className = "wof-color-picker";
			picker.title = "Slice color for this action";
			picker.value = swatchColor;

			const reset = document.createElement("button");
			reset.type = "button";
			reset.className = "wof-color-reset";
			reset.title = "Reset to default color";
			reset.textContent = "\u2715";

			// Re-derive identity at event time, the row's type/text/duration
			// may have changed since injection.
			picker.addEventListener("input", () => {
				const liveSeg = extractSegmentFromRow(row, i);
				const current = loadColors();
				current[segmentIdentity(liveSeg)] = picker.value;
				saveColors(current);
			});

			reset.addEventListener("click", () => {
				const liveSeg = extractSegmentFromRow(row, i);
				const current = loadColors();
				delete current[segmentIdentity(liveSeg)];
				saveColors(current);
				picker.value = DEFAULT_SWATCH;
			});

			wrap.appendChild(picker);
			wrap.appendChild(reset);
			row.insertBefore(wrap, anchor);
		});
	}

	// Shuffle actions reorders Formik state only, it does not add or remove
	// row DOM nodes, so our MutationObserver below never fires for it and
	// injectColorPickers never gets a chance to re-sync. Hook the button
	// directly instead.
	function hookShuffleButton(modal) {
		if (modal.dataset.wofShuffleHooked) return;
		const shuffleBtn = [...modal.querySelectorAll("button")].find((b) => b.textContent.trim().includes("Shuffle actions"));
		if (!shuffleBtn) return;
		modal.dataset.wofShuffleHooked = "1";
		shuffleBtn.addEventListener("click", () => {
			// The click handler runs before Formik/React finish re-rendering
			// the shuffled values, give it a beat before re-reading rows.
			setTimeout(() => injectColorPickers(modal), 50);
		});
	}

	// Drag-and-drop reordering. The row's own index is kept fresh on every
	// call (rows get added/removed, so positions shift), but the actual
	// drag/drop event listeners are only wired once per row.
	function injectDragHandles(modal) {
		const rows = modal.querySelectorAll(".card-content");
		rows.forEach((row, i) => {
			row.dataset.wofRowIndex = String(i);

			if (!row.querySelector(".wof-drag-handle")) {
				const handle = document.createElement("span");
				handle.className = "wof-drag-handle";
				handle.textContent = "\u22ee\u22ee";
				handle.title = "Drag to reorder";
				row.insertBefore(handle, row.firstChild);
			}

			if (row.dataset.wofDragWired) return;
			row.dataset.wofDragWired = "1";
			row.draggable = true;

			row.addEventListener("dragstart", (e) => {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", row.dataset.wofRowIndex);
				row.classList.add("wof-dragging");
			});

			row.addEventListener("dragend", () => {
				row.classList.remove("wof-dragging");
				modal.querySelectorAll(".wof-drop-target").forEach((el) => el.classList.remove("wof-drop-target"));
			});

			row.addEventListener("dragover", (e) => {
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				row.classList.add("wof-drop-target");
			});

			row.addEventListener("dragleave", () => {
				row.classList.remove("wof-drop-target");
			});

			row.addEventListener("drop", (e) => {
				e.preventDefault();
				row.classList.remove("wof-drop-target");
				const sourceIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
				const destIndex = parseInt(row.dataset.wofRowIndex, 10);
				reorderSegments(modal, sourceIndex, destIndex);
			});
		});
	}

	/*
	 * Canvas patch, makes the wheel actually draw the saved colors
	 */

	let latestSegments = null;

	function scanForWheelSegments(node, depth) {
		if (!node || typeof node !== "object" || depth > 6) return;
		if (node.slug === "wheel-of-fortune" && node.config && Array.isArray(node.config.segments)) {
			latestSegments = node.config.segments;
			return;
		}
		for (const key in node) {
			if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
			const value = node[key];
			if (value && typeof value === "object") {
				scanForWheelSegments(value, depth + 1);
			}
		}
	}

	function tryScanText(text) {
		if (!text || text.indexOf("wheel-of-fortune") === -1) return;
		try {
			scanForWheelSegments(JSON.parse(text), 0);
		} catch (e) {
			// not JSON, or not the shape we want, ignore
		}
	}

	const originalFetch = window.fetch;
	if (originalFetch) {
		window.fetch = function (...args) {
			return originalFetch.apply(this, args).then((response) => {
				response
					.clone()
					.text()
					.then(tryScanText)
					.catch(() => {});
				return response;
			});
		};
	}

	const originalXhrSend = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.send = function (...args) {
		this.addEventListener("load", () => {
			try {
				tryScanText(this.responseText);
			} catch (e) {
				// responseType other than text, ignore
			}
		});
		return originalXhrSend.apply(this, args);
	};

	/*
	 * Responsive + high-DPI wheel sizing. Chaster caps the wheel at a fixed
	 * 350px regardless of how much room the page actually has, and draws
	 * the canvas backing buffer at that same 350px, so on a retina/HDPI
	 * screen everything (arcs, and now our fitted labels too) is genuinely
	 * rendered at low resolution and then upscaled by the browser, which is
	 * what makes it look soft. Chaster's own drawing class reads
	 * canvas.width directly for all of its geometry, so a bigger backing
	 * buffer scales everything proportionally with no extra math needed on
	 * our side, we just need canvas.width to already be bigger whenever
	 * that class reads it.
	 *
	 * Two things needed combining here, each solving a problem the other
	 * doesn't:
	 *
	 * - Measuring the container reliably. React sets the canvas's initial
	 *   width/height during its commit phase, which can run before layout
	 *   has actually settled, getBoundingClientRect() on a container that
	 *   hasn't been laid out yet returns zero, not a small-but-real number,
	 *   and sizing off a phantom zero is what shrank the wheel below even
	 *   Chaster's own 350px default in practice. getContext("2d") is
	 *   called later, from inside Chaster's own useEffect, which always
	 *   runs after commit and after layout has settled, so that's the
	 *   reliable place to actually measure and cache a size.
	 *
	 * - Defending that size afterward. Resizing this container via CSS is
	 *   very likely to trigger Chaster's own container-measuring hook to
	 *   recompute its size, and even though its own result stays capped at
	 *   350, React still re-applies that capped value to the canvas's
	 *   width/height on the resulting re-render, undoing whatever we'd set
	 *   at mount. A one-shot hook has no way to defend against a later
	 *   re-assertion, so the width/height properties themselves are
	 *   patched too, using the size already cached above rather than
	 *   re-measuring (avoiding the same zero-during-commit problem a
	 *   second time), so every future attempt to set them, by React or
	 *   anyone else, gets our cached value substituted in instead.
	 *
	 * Setting width/height on a canvas clears it even when the value is
	 * unchanged, and we have no handle on Chaster's private drawing
	 * instance to tell it to repaint afterward, so the setter below skips
	 * the reassignment entirely when we're already at the resolution we
	 * want, and the getContext hook's own reassignment is safe because
	 * it's always immediately followed by that same constructor's caller
	 * invoking draw() for the first time.
	 *
	 * A plain window resize does NOT remount it, so a resize alone only
	 * gets a re-fit CSS display size and cached value (safe, doesn't touch
	 * the canvas itself), not a re-fit backing resolution. It'll catch up
	 * as soon as anything (React's own resize handling, or editing and
	 * saving the wheel's segments) causes a re-render that touches
	 * width/height again.
	 */

	const WHEEL_MIN_SIZE_PX = 220;
	const WHEEL_MAX_SIZE_PX = 640;
	const WHEEL_CONTAINER_PADDING_PX = 24;

	let lastKnownWheelDisplaySize = null;

	const WHEEL_POINTER_HALF_WIDTH_PX = 16;
	// Equilateral: base (2x half-width) equals both slanted sides, which
	// works out to height = halfWidth * sqrt(3).
	const WHEEL_POINTER_HEIGHT_PX = Math.round(WHEEL_POINTER_HALF_WIDTH_PX * Math.sqrt(3));
	const WHEEL_POINTER_OVERLAP_PX = 6;
	const WHEEL_POINTER_COLOR = "#1a1a1a";
	// How far the pointer pokes above .wheel-container's own top edge, plus
	// a little breathing room so it doesn't sit flush against whatever's
	// above it on the page.
	const WHEEL_CONTAINER_TOP_MARGIN_PX = WHEEL_POINTER_HEIGHT_PX - WHEEL_POINTER_OVERLAP_PX + 8;

	function injectWheelSizeStyles() {
		if (document.getElementById("wof-wheel-size-styles")) return;
		const style = document.createElement("style");
		style.id = "wof-wheel-size-styles";
		style.textContent = `
			.wheel-container {
				width: var(--wof-wheel-size, 350px) !important;
				max-width: 100% !important;
				margin-top: ${WHEEL_CONTAINER_TOP_MARGIN_PX}px !important;
				margin-left: auto !important;
				margin-right: auto !important;
				background-image: none !important;
			}
			.wheel-container .wheel {
				width: var(--wof-wheel-size, 350px) !important;
				height: var(--wof-wheel-size, 350px) !important;
				background-image: none !important;
				position: relative;
			}
			.wheel-container .wheel canvas {
				width: var(--wof-wheel-size, 350px) !important;
				height: var(--wof-wheel-size, 350px) !important;
			}
			.wheel-container .wheel::before {
				content: "";
				position: absolute;
				top: -${WHEEL_POINTER_HEIGHT_PX - WHEEL_POINTER_OVERLAP_PX}px;
				left: 50%;
				transform: translateX(-50%);
				width: 0;
				height: 0;
				border-left: ${WHEEL_POINTER_HALF_WIDTH_PX}px solid transparent;
				border-right: ${WHEEL_POINTER_HALF_WIDTH_PX}px solid transparent;
				border-top: ${WHEEL_POINTER_HEIGHT_PX}px solid ${WHEEL_POINTER_COLOR};
				z-index: 5;
				pointer-events: none;
			}
		`;
		document.head.appendChild(style);
	}

	// Chaster's own stand/pointer background image (wheel_back.png) is
	// stripped via the background-image: none rules above rather than
	// scaled, we're drawing our own pointer instead. If it's applied
	// somewhere other than .wheel-container or .wheel, this won't reach
	// it, that part I can't guarantee without seeing the live CSS.
	function computeWheelDisplaySize(container) {
		const outer = container.closest(".card-content") || container.parentElement || container;
		const rawAvailable = outer.getBoundingClientRect().width;
		// Zero (or negative once padding is subtracted) means layout
		// hasn't settled yet rather than a genuinely tiny container, a
		// real narrow viewport still reports some small positive number.
		if (rawAvailable <= 0) return null;
		const available = rawAvailable - WHEEL_CONTAINER_PADDING_PX;
		return Math.max(WHEEL_MIN_SIZE_PX, Math.min(WHEEL_MAX_SIZE_PX, Math.floor(available)));
	}

	function applyWheelDisplaySize(container) {
		injectWheelSizeStyles();
		const size = computeWheelDisplaySize(container);
		if (size !== null) {
			lastKnownWheelDisplaySize = size;
			document.documentElement.style.setProperty("--wof-wheel-size", size + "px");
		}
		return lastKnownWheelDisplaySize;
	}

	let wheelResizeDebounce = null;
	window.addEventListener("resize", () => {
		clearTimeout(wheelResizeDebounce);
		wheelResizeDebounce = setTimeout(() => {
			const container = document.querySelector(".wheel-container");
			if (container) applyWheelDisplaySize(container);
		}, 150);
	});

	function isWheelCanvasElement(canvas) {
		// id-based rather than closest()-based: at the very first
		// width/height assignment during React's initial commit this
		// element may not be attached to its parent chain yet, but its id
		// is already set by then, so this still matches from the start.
		return !!(canvas && canvas.id === "canvas");
	}

	function patchCanvasDimension(propName) {
		const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, propName);
		if (!descriptor || !descriptor.configurable) return;
		Object.defineProperty(HTMLCanvasElement.prototype, propName, {
			configurable: true,
			enumerable: descriptor.enumerable,
			get: function () {
				return descriptor.get.call(this);
			},
			set: function (value) {
				if (isWheelCanvasElement(this)) {
					const dpr = window.devicePixelRatio || 1;
					const displaySize = lastKnownWheelDisplaySize || value;
					const desired = Math.round(displaySize * dpr);
					if (descriptor.get.call(this) === desired) {
						// Already at the resolution we want. Skip the
						// reassignment entirely, setting width/height to
						// the same value still clears the canvas, and
						// nothing here can guarantee a repaint follows.
						return;
					}
					value = desired;
				}
				return descriptor.set.call(this, value);
			},
		});
	}

	patchCanvasDimension("width");
	patchCanvasDimension("height");

	// React most likely sets width/height via setAttribute rather than the
	// JS property (that's its usual path for plain HTML attributes like
	// this one), which would completely bypass the property patch above,
	// it's a separate code path, not routed through the accessor at all.
	// If that's what's been happening, this is what actually closes the
	// gap: React's own re-renders go through here too, whichever path they
	// use.
	const originalCanvasSetAttribute = HTMLCanvasElement.prototype.setAttribute;
	HTMLCanvasElement.prototype.setAttribute = function (name, value) {
		if ((name === "width" || name === "height") && isWheelCanvasElement(this)) {
			const dpr = window.devicePixelRatio || 1;
			const parsedValue = parseFloat(value);
			const displaySize = lastKnownWheelDisplaySize || (Number.isFinite(parsedValue) ? parsedValue : 0);
			const desired = Math.round(displaySize * dpr);
			if (parseFloat(this.getAttribute(name)) === desired) {
				return;
			}
			value = String(desired);
		}
		return originalCanvasSetAttribute.call(this, name, value);
	};

	const originalGetContext = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
		if (type === "2d" && this.id === "canvas") {
			const container = this.closest(".wheel-container");
			if (container) {
				// Reliable timing: runs from inside Chaster's own
				// constructor, called from useEffect, always after commit
				// with layout settled, so the container is genuinely
				// measurable here even when it wasn't yet during the
				// earlier commit.
				applyWheelDisplaySize(container);
				// Assigning a plain (un-scaled) logical size here and
				// letting the patched setter above apply devicePixelRatio
				// keeps the multiplication in one place. Safe to reassign:
				// always immediately followed by this same constructor's
				// caller invoking draw() for the first time.
				this.width = lastKnownWheelDisplaySize;
				this.height = lastKnownWheelDisplaySize;
			}
		}
		return originalGetContext.call(this, type, ...rest);
	};

	function isWheelCanvas(canvas) {
		return !!(canvas && canvas.closest && canvas.closest(".wheel"));
	}

	// Tracks, per 2d context, how many times fillStyle has been set since
	// the last clearRect. The wheel's draw loop always does:
	//   clearRect, then for each segment: [set slice color, fill] [set text color, fillText]
	// so fillStyle assignments alternate slice/text/slice/text in order.
	// Even-indexed assignments (0, 2, 4, ...) are slice colors, odd ones
	// are the text color. That parity is all we need, we never match
	// against a literal color string.
	const fillCounters = new WeakMap();

	const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
	CanvasRenderingContext2D.prototype.clearRect = function (...args) {
		if (isWheelCanvas(this.canvas)) {
			fillCounters.set(this, 0);
		}
		return originalClearRect.apply(this, args);
	};

	const fillStyleDescriptor = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, "fillStyle");
	if (fillStyleDescriptor && fillStyleDescriptor.configurable) {
		Object.defineProperty(CanvasRenderingContext2D.prototype, "fillStyle", {
			configurable: true,
			enumerable: fillStyleDescriptor.enumerable,
			get: function () {
				return fillStyleDescriptor.get.call(this);
			},
			set: function (value) {
				if (isWheelCanvas(this.canvas)) {
					const count = fillCounters.get(this) || 0;
					const isSliceFill = count % 2 === 0;
					if (isSliceFill && latestSegments) {
						const rawSeg = latestSegments[count / 2];
						const seg = normalizeApiSegment(rawSeg);
						const colors = loadColors();
						const override = colors[segmentIdentity(seg)];
						if (override) value = override;
					}
					fillCounters.set(this, count + 1);
				}
				return fillStyleDescriptor.set.call(this, value);
			},
		});
	}

	/*
	 * Slice label rendering. Text is drawn along the radial direction (each
	 * segment's own rotation tilts it to point out from the hub), so a
	 * string's rendered *width* is how far it reaches radially, while its
	 * *height* (the font size) is what determines whether it stays inside
	 * its own wedge or bleeds tangentially into the slice next door.
	 * Chaster's own drawText shrinks font size against a flat 36% of canvas
	 * width, treating that as a length budget, it never separately checks
	 * whether the resulting font height fits the wedge's actual tangential
	 * width, which on a wheel with a lot of segments is much narrower than
	 * the label's own reach toward the hub. That's what crops labels into
	 * neighboring slices. It also anchors the baseline with a fixed y
	 * offset instead of a true vertical center.
	 *
	 * The fix picks a font size from the wedge's true width at a reference
	 * radius close to the hub (the tightest point any label passes through
	 * on its way toward center, since every wedge narrows to a point at
	 * r=0), then lets the text run radially within a fixed budget, shrinking
	 * further and finally truncating with an ellipsis if a label is still
	 * too long at the smallest legible size. It does not wrap onto extra
	 * lines: stacking wrapped lines sideways is a tangential offset, the
	 * same mistake that caused the bleed in the first place.
	 */

	const WHEEL_TEXT_MIN_FONT_PX = 7;
	const WHEEL_TEXT_MAX_FONT_PX = 20;
	// Reference radius (fraction of canvas width) used only to work out the
	// tangential ceiling on font size. Every wedge keeps narrowing all the
	// way to the hub, so treating this close-in point as the worst case
	// keeps text from ever bleeding into a neighboring wedge, regardless of
	// how far outward the label's own radial reach goes.
	const WHEEL_TEXT_INNER_BOUND_FRACTION = 0.14;
	// Outer edge of the radial run labels are allowed, leaves margin
	// before the rim.
	const WHEEL_TEXT_OUTER_BOUND_FRACTION = 0.46;
	// Fraction of the true tangential width at the reference radius that
	// font size is allowed to use. Below 1 on purpose, leaves a visible gap
	// between neighboring labels instead of them touching edge to edge.
	const WHEEL_TEXT_GAP_PADDING = 0.85;
	const WHEEL_TEXT_FONT_FAMILY = "Nunito";

	function fitSliceText(ctx, text, canvasWidth, segmentCount) {
		const sliceAngle = (2 * Math.PI) / segmentCount;
		const innerBoundRadius = WHEEL_TEXT_INNER_BOUND_FRACTION * canvasWidth;
		const chordAtInnerBound = 2 * innerBoundRadius * Math.sin(sliceAngle / 2);
		const geometryFontPx = Math.floor(chordAtInnerBound * WHEEL_TEXT_GAP_PADDING);
		const maxFontPx = Math.min(WHEEL_TEXT_MAX_FONT_PX, Math.max(WHEEL_TEXT_MIN_FONT_PX, geometryFontPx));
		const radialBudget = (WHEEL_TEXT_OUTER_BOUND_FRACTION - WHEEL_TEXT_INNER_BOUND_FRACTION) * canvasWidth;

		for (let size = maxFontPx; size >= WHEEL_TEXT_MIN_FONT_PX; size--) {
			ctx.font = `normal ${size}px ${WHEEL_TEXT_FONT_FAMILY}`;
			if (ctx.measureText(text).width <= radialBudget) {
				return { fontSize: size, text };
			}
		}

		// Doesn't fit even at the smallest legible size, a long label on a
		// heavily segmented wheel. Truncate with an ellipsis rather than
		// wrap it into a second line stacked at a different radius, which
		// would read strangely (see the comment block above this function).
		ctx.font = `normal ${WHEEL_TEXT_MIN_FONT_PX}px ${WHEEL_TEXT_FONT_FAMILY}`;
		let truncated = text;
		while (truncated.length > 1 && ctx.measureText(truncated + "\u2026").width > radialBudget) {
			truncated = truncated.slice(0, -1);
		}
		return { fontSize: WHEEL_TEXT_MIN_FONT_PX, text: truncated.length < text.length ? truncated + "\u2026" : truncated };
	}

	const originalFillText = CanvasRenderingContext2D.prototype.fillText;
	CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
		if (!isWheelCanvas(this.canvas) || !latestSegments || latestSegments.length === 0) {
			return originalFillText.call(this, text, x, y, maxWidth);
		}

		const anchorRadius = ((WHEEL_TEXT_INNER_BOUND_FRACTION + WHEEL_TEXT_OUTER_BOUND_FRACTION) / 2) * this.canvas.width;
		const fit = fitSliceText(this, text, this.canvas.width, latestSegments.length);

		this.save();
		this.font = `normal ${fit.fontSize}px ${WHEEL_TEXT_FONT_FAMILY}`;
		this.textAlign = "center";
		this.textBaseline = "middle";
		originalFillText.call(this, fit.text, anchorRadius, 0);
		this.restore();
	};

	/*
	 * Modal observer
	 */

	function tryInject() {
		document.querySelectorAll(".modal-title").forEach((title) => {
			if (!title.textContent.includes("Wheel of Fortune")) return;
			const modal = title.closest(".modal-content");
			if (!modal) return;
			if (!modal.querySelector(`#${INJECT_MARKER}`)) {
				const hrs = modal.querySelectorAll("hr");
				const anchor = hrs[1] ?? hrs[0];
				if (anchor) anchor.parentNode.insertBefore(buildToolbar(modal), anchor.nextSibling);
			}
			injectColorPickers(modal);
			hookShuffleButton(modal);
			injectDragHandles(modal);
		});
	}

	function startObserving() {
		new MutationObserver(tryInject).observe(document.body, { childList: true, subtree: true });
		tryInject();
	}

	if (document.body) {
		startObserving();
	} else {
		document.addEventListener("DOMContentLoaded", startObserving);
	}
})();
