// ==UserScript==
// @name         Chaster Wheel of Fortune Config Import/Export + Custom Colors
// @namespace    http://tampermonkey.net/
// @match        https://chaster.app/*
// @match        https://*.chaster.app/*
// @version      3.3
// @description  Adds import/export buttons (weights included), per-slice color pickers, and drag-and-drop reordering to the Wheel of Fortune modal on chaster.app, makes the wheel canvas render those colors, correctly sizes/centers the slice text, makes the wheel responsive to its container at higher resolution for crisp HDPI rendering, and replaces Chaster's stand/pointer background image with a small CSS pointer overlapping the wheel.
// @author       earlekastle
// @icon         https://chaster.app/favicon.png
// @run-at       document-start
// @grant        none
// @updateURL    https://github.com/earlekastle/chaster-wof-config/raw/refs/heads/main/script.user.js
// @downloadURL  https://github.com/earlekastle/chaster-wof-config/raw/refs/heads/main/script.user.js
// ==/UserScript==

(function () {
	"use strict";

	// @grant none is required here on purpose. It runs this script in the
	// page's own JS realm instead of a sandbox, which is the only way the
	// CanvasRenderingContext2D patch further down can actually affect the
	// page's own canvas draws, and the only way to read the React fiber
	// properties used to reach Chaster's form and wheel state.

	/*
	 * Constants
	 */

	const INJECT_MARKER = "wof-config-injected";
	const DURATION_TYPES = new Set(["add-time", "remove-time", "add-remove-time", "pillory"]);
	const COLOR_STORAGE_KEY = "wof-slice-colors-v1";
	const DEFAULT_SWATCH = "#cccccc";
	// Chaster's own default for a freshly added row, reused for imported
	// rows that don't carry a duration so switching their type later in
	// the UI doesn't start from zero and fail validation.
	const DEFAULT_SEGMENT_DURATION_S = 3600;
	const WEIGHT_MIN = 1;
	const WEIGHT_MAX = 100;

	/*
	 * Duration helpers
	 */

	function secondsToDHM(totalSeconds) {
		totalSeconds = Math.round(totalSeconds || 0);
		const days = Math.floor(totalSeconds / 86400);
		let rem = totalSeconds % 86400;
		const hours = Math.floor(rem / 3600);
		rem %= 3600;
		const minutes = Math.floor(rem / 60);
		return { days, hours, minutes };
	}

	// Exports store { days, hours, minutes } so older WheelConfig.json files
	// stay readable, but a raw number of seconds (the shape Chaster's own
	// API uses) is accepted too.
	function toSeconds(duration) {
		if (typeof duration === "number") return Math.max(0, Math.round(duration));
		if (!duration || typeof duration !== "object") return null;
		return (duration.days || 0) * 86400 + (duration.hours || 0) * 3600 + (duration.minutes || 0) * 60;
	}

	function clampWeight(weight) {
		const n = Math.round(Number(weight));
		if (!Number.isFinite(n)) return 1;
		return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, n));
	}

	// Drive a NodeList of .DurationSelectorItem spinners to { days, hours, minutes }.
	// Only used for the regularity selector now, which lives in a separate
	// React context from the segment form and has no form control to write to.
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

	/*
	 * React fiber access. Chaster's config modal is a react-hook-form form
	 * with a useFieldArray of segments, and every row component receives
	 * the form's `control` object as a prop. Writing through that control
	 * is instant and exact, where the old approach (clicking "Add an
	 * action", then driving each row's select and duration popover) broke
	 * the moment Chaster swapped its native <select> for a Joy UI Select.
	 */

	function getFiber(el) {
		if (!el) return null;
		// Own keys only. for...in would also walk every inherited DOM
		// property, and this runs once per animation frame while spinning.
		const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
		return key ? el[key] : null;
	}

	function findFiberUp(el, predicate, maxDepth = 40) {
		let fiber = getFiber(el);
		for (let depth = 0; fiber && depth < maxDepth; depth++) {
			if (predicate(fiber)) return fiber;
			fiber = fiber.return;
		}
		return null;
	}

	function isFormControl(c) {
		return !!(c && typeof c._reset === "function" && c._formValues && typeof c._formValues === "object");
	}

	function getFormControl(modal) {
		// The weights and shuffle checkboxes are Controllers bound to the
		// same control, and exist even when the segment list is empty.
		const starts = [
			modal.querySelector('input[name="weightsEnabled"]'),
			modal.querySelector('input[name="shuffleSegments"]'),
			modal.querySelector(".actions .card-content"),
		];
		for (const start of starts) {
			const fiber = findFiberUp(start, (f) => isFormControl(f.memoizedProps?.control));
			if (fiber) return fiber.memoizedProps.control;
		}
		return null;
	}

	function getFormValues(modal) {
		const control = getFormControl(modal);
		if (!control) return null;
		const v = control._formValues;
		return {
			segments: Array.isArray(v.segments) ? v.segments.map((s) => ({ ...s })) : [],
			shuffleSegments: !!v.shuffleSegments,
			weightsEnabled: !!v.weightsEnabled,
		};
	}

	function setFormValues(modal, values) {
		const control = getFormControl(modal);
		if (!control) return false;
		// _reset is what the public reset() calls. It swaps every value at
		// once and notifies useFieldArray, so the row list re-renders with
		// fresh keys and every Controller re-registers itself.
		control._reset(values);
		return true;
	}

	function getSegmentRows(modal) {
		return [...modal.querySelectorAll(".actions > .card-content")];
	}

	/*
	 * Segment identity, shared by the modal reader, the JSON import/export,
	 * and the canvas color override, so all three agree on what counts as
	 * "the same segment". Segments have no id in Chaster's data model, so
	 * this is the closest thing to one. Weight is deliberately left out, so
	 * changing a slice's weight doesn't lose its color.
	 */

	// Normalizes a raw segment (duration in seconds, the shape both the
	// form and the API use) into the export shape.
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

	function rawSegmentIdentity(raw) {
		return segmentIdentity(normalizeApiSegment(raw));
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
			weightsEnabled: false,
			shuffleSegments: false,
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

		// Segments, straight from the form state
		const form = getFormValues(modal);
		if (!form) {
			console.warn("WoF: could not reach the form state, export will have no segments");
			return config;
		}
		config.weightsEnabled = form.weightsEnabled;
		config.shuffleSegments = form.shuffleSegments;

		const colors = loadColors();
		form.segments.forEach((raw) => {
			const seg = normalizeApiSegment(raw);
			if (!seg) return;
			seg.weight = clampWeight(raw.weight ?? 1);
			const color = colors[segmentIdentity(seg)];
			if (color) seg.color = color;
			config.segments.push(seg);
		});

		return config;
	}

	/*
	 * Apply config
	 */

	function toFormSegment(seg) {
		const type = seg.type;
		const seconds = toSeconds(seg.duration);
		return {
			type,
			duration: DURATION_TYPES.has(type) && seconds !== null ? seconds : DEFAULT_SEGMENT_DURATION_S,
			text: typeof seg.text === "string" ? seg.text : "",
			weight: clampWeight(seg.weight ?? 1),
		};
	}

	async function applyConfigToModal(modal, config, statusEl) {
		setStatus(statusEl, "⏳ Applying config…");

		// Mode
		if (config.mode) {
			const radio = modal.querySelector(`#mode-${config.mode}`);
			if (radio) radio.click();
			await sleep(100); // regularity selector appears or disappears with the mode
		}

		// Regularity, scoped to .d-sm-flex
		if (config.regularity) {
			const regularitySelector = modal.querySelector(".d-sm-flex .DurationSelector");
			if (regularitySelector) {
				const items = regularitySelector.querySelectorAll(".DurationSelectorItem");
				await applyDurationToItems(items, config.regularity);
			}
		}

		// Segments, weights, shuffle flag
		if (Array.isArray(config.segments) && config.segments.length > 0) {
			const current = getFormValues(modal);
			if (!current) {
				setStatus(statusEl, "❌ Could not reach the wheel form, see console");
				console.warn("WoF: no react-hook-form control found on the modal");
				return;
			}
			const ok = setFormValues(modal, {
				segments: config.segments.map(toFormSegment),
				// Absent in exports from 3.0 and earlier. Keep whatever the
				// modal already has rather than forcing weights off.
				weightsEnabled: typeof config.weightsEnabled === "boolean" ? config.weightsEnabled : current.weightsEnabled,
				shuffleSegments: typeof config.shuffleSegments === "boolean" ? config.shuffleSegments : current.shuffleSegments,
			});
			if (!ok) return;

			// Colors: only set if this segment's JSON explicitly carries one.
			// Segments with no "color" key are left however they currently
			// are, importing an old export (or one without colors set) never
			// wipes out colors you've already picked for matching segments.
			const colors = loadColors();
			config.segments.forEach((seg) => {
				if (seg.color) colors[rawSegmentIdentity(toFormSegment(seg))] = seg.color;
			});
			saveColors(colors);

			// Rows remount with new keys, so the observer re-injects
			// pickers on its own. This just covers the gap before it fires.
			setTimeout(() => {
				injectColorPickers(modal);
				injectDragHandles(modal);
			}, 50);
		}

		setStatus(statusEl, "✅ Done!");
		setTimeout(() => setStatus(statusEl, ""), 3000);
	}

	// Drag-and-drop reordering. destIndexOriginal is expressed in the
	// array's ORIGINAL (pre-removal) numbering, e.g. "drop after the row
	// currently at index 2" is destIndexOriginal = 3. Removing the dragged
	// item shifts every later index down by one, so that gets corrected for
	// below before splicing it back in.
	function reorderSegments(modal, sourceIndex, destIndexOriginal) {
		if (Number.isNaN(sourceIndex) || Number.isNaN(destIndexOriginal)) return;
		const form = getFormValues(modal);
		if (!form) return;
		const segments = form.segments;
		if (sourceIndex < 0 || sourceIndex >= segments.length) return;

		const adjustedDest = destIndexOriginal > sourceIndex ? destIndexOriginal - 1 : destIndexOriginal;
		const destIndex = Math.max(0, Math.min(segments.length - 1, adjustedDest));
		if (destIndex === sourceIndex) return;

		const [moved] = segments.splice(sourceIndex, 1);
		segments.splice(destIndex, 0, moved);
		setFormValues(modal, form);
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

		const exportBtn = makeButton("Export JSON", "#171A1C", "Download current config (including weights and colors) as a JSON file");
		exportBtn.addEventListener("click", () => {
			const blob = new Blob([JSON.stringify(readModalState(modal), null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = Object.assign(document.createElement("a"), { href: url, download: "WheelConfig.json" });
			a.click();
			URL.revokeObjectURL(url);
		});

		const importBtn = makeButton("Import JSON", "#6D7DD1", "Import a WheelConfig.json and fully apply it, weights and colors included");
		importBtn.addEventListener("click", () => {
			const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json" });
			input.addEventListener("change", async () => {
				const file = input.files[0];
				if (!file) return;
				let config;
				try {
					config = JSON.parse(await file.text());
				} catch (e) {
					alert("Failed to parse JSON: " + e.message);
					return;
				}
				try {
					await applyConfigToModal(modal, config, statusEl);
				} catch (e) {
					console.error("WoF: import failed", e);
					setStatus(statusEl, "\u274c Import failed, see console");
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
				gap: 2px;
				flex-shrink: 0;
			}
			.wof-color-picker-wrap.wof-push-right {
				margin-left: auto;
			}
			/* Weight label: the word becomes Font Awesome 5 Pro's
			   balance-scale-left (FA6 calls it scale-unbalanced), which
			   Chaster already loads. font-size 0 hides the text but keeps
			   it for screen readers. Rules here that overlap Chaster's
			   own need !important, because Emotion injects its styles
			   after this sheet at equal specificity. */
			[data-wof-weight-row] > label {
				font-size: 0 !important;
			}
			[data-wof-weight-row] > label::before {
				content: "\\f515"; /* double backslash: this CSS sits in a JS template literal */
				font-family: "Font Awesome 5 Pro";
				font-weight: 400;
				font-size: 16px;
				opacity: 0.7;
			}
			/* One line per row. Chaster's content box wraps, and puts the
			   weight control on its own line below 600px on purpose, so
			   this only applies above that. Instead of wrapping, the text
			   field (or the duration link / freeze description) shrinks. */
			@media (min-width: 600px) {
				[data-wof-row-content] {
					flex-wrap: nowrap !important;
					column-gap: 8px !important;
				}
				[data-wof-row-content] > * {
					min-width: 0 !important;
				}
				[data-wof-row-content] > :first-child,
				[data-wof-row-content] > [data-wof-weight-control] {
					flex-shrink: 0 !important;
				}
				[data-wof-row-content] > [data-wof-text-field] {
					flex: 1 1 auto !important;
				}
				[data-wof-text-field] * {
					min-width: 0 !important;
				}
				[data-wof-text-field] input {
					width: 100% !important;
				}
				[data-wof-weight-row] {
					gap: 6px !important;
				}
			}
			.wof-color-picker {
				width: 24px;
				height: 24px;
				padding: 0;
				border: none;
				border-radius: 50%;
				cursor: pointer;
				background: none;
			}
			.wof-color-picker::-webkit-color-swatch-wrapper {
				padding: 0;
			}
			.wof-color-picker::-webkit-color-swatch {
				border: none;
				border-radius: 50%;
			}
			.wof-color-picker::-moz-color-swatch {
				border: none;
				border-radius: 50%;
			}
			.wof-color-reset {
				cursor: pointer;
				opacity: 0.4;
				font-size: 11px;
				padding: 0 2px;
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
			.wof-drop-indicator {
				position: fixed;
				height: 4px;
				background: #6d7dd1;
				border-radius: 2px;
				pointer-events: none;
				z-index: 10000;
				display: none;
			}
		`;
		document.head.appendChild(style);
	}


	function injectColorPickers(modal) {
		injectPickerStyles();

		const form = getFormValues(modal);
		if (!form) return;
		const colors = loadColors();

		getSegmentRows(modal).forEach((row, i) => {
			const raw = form.segments[i];
			if (!raw) return;
			const swatchColor = colors[rawSegmentIdentity(raw)] || DEFAULT_SWATCH;

			const existingWrap = row.querySelector(".wof-color-picker-wrap");
			if (existingWrap) {
				// The row already has a picker. Deleting an earlier row or
				// changing this row's type/duration/text keeps the DOM node
				// but changes what it represents, so re-sync the displayed
				// value to whatever now actually lives in this row. Skip it
				// while the user has the native color popup focused so we
				// don't fight their in-progress pick.
				const picker = existingWrap.querySelector(".wof-color-picker");
				if (picker && document.activeElement !== picker) {
					picker.value = swatchColor;
				}
				placeColorPicker(row, existingWrap);
				return;
			}

			if (!getRowContent(row)) return;

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
			reset.textContent = "✕";

			// Re-derive index and identity at event time, rows above this
			// one may have been deleted and this row's own values may have
			// changed since injection.
			function liveIdentity() {
				const index = getSegmentRows(modal).indexOf(row);
				const liveRaw = getFormValues(modal)?.segments[index];
				return liveRaw ? rawSegmentIdentity(liveRaw) : null;
			}

			picker.addEventListener("input", () => {
				const identity = liveIdentity();
				if (!identity) return;
				const current = loadColors();
				current[identity] = picker.value;
				saveColors(current);
			});

			reset.addEventListener("click", () => {
				const identity = liveIdentity();
				if (!identity) return;
				const current = loadColors();
				delete current[identity];
				saveColors(current);
				picker.value = DEFAULT_SWATCH;
			});

			wrap.appendChild(picker);
			wrap.appendChild(reset);
			placeColorPicker(row, wrap);
		});
	}

	// The flex box holding the row's type select, text/duration field, and
	// (when weights are on) the weight control. Found as the row's direct
	// child containing the type combobox, not by its generated class.
	function getRowContent(row) {
		return [...row.children].find((c) => c.querySelector('[role="combobox"]')) || null;
	}

	// Where the picker lives depends on whether weights are on. Sitting
	// outside the content box as its own flex item squeezes the content
	// enough to wrap the weight control onto a second line, so it goes
	// inside instead:
	// - weights on: appended to the weight control's own inline row, right
	//   after the percentage, so it moves and wraps together with it
	// - weights off: last item in the content box, pushed to the right
	// React adds and removes the weight control when weights are toggled
	// (taking the picker with it on removal), and the observer calls this
	// again each time, so the picker ends up back in the right place. Every
	// branch checks before moving so the mutation it causes is a no-op on
	// the next pass.
	function placeColorPicker(row, wrap) {
		const content = getRowContent(row);
		if (!content) return;

		const weightInput = content.querySelector('input[type="number"]');
		const weightControl = weightInput && [...content.children].find((c) => c.contains(weightInput));
		const weightRow = weightControl?.firstElementChild;

		const home = weightRow && weightRow.contains(weightInput) ? weightRow : content;
		wrap.classList.toggle("wof-push-right", home === content);

		// Hooks for the one-line layout CSS in injectPickerStyles. Data
		// attributes rather than classes, because React overwrites
		// className on re-render but leaves attributes it didn't set alone.
		content.dataset.wofRowContent = "1";
		if (weightControl) weightControl.dataset.wofWeightControl = "1";
		if (home === weightRow) {
			weightRow.dataset.wofWeightRow = "1";
			const label = weightRow.querySelector(":scope > label");
			if (label && !label.title) label.title = label.textContent;
		}
		// The free-text field. The select's own hidden input has no
		// placeholder, so this only matches the Text action's input.
		const textInput = content.querySelector("input[placeholder]");
		const textField = textInput && [...content.children].find((c) => c.contains(textInput));
		if (textField) textField.dataset.wofTextField = "1";
		if (wrap.parentElement !== home || home.lastElementChild !== wrap) {
			home.appendChild(wrap);
		}
	}

	// Drag-and-drop reordering. Indexes are looked up live at drag/drop
	// time since rows get added and removed, but the listeners are only
	// wired once per row.
	let wheelReorderIndicator = null;

	function getWheelReorderIndicator() {
		if (wheelReorderIndicator && document.body.contains(wheelReorderIndicator)) {
			return wheelReorderIndicator;
		}
		wheelReorderIndicator = document.createElement("div");
		wheelReorderIndicator.className = "wof-drop-indicator";
		// Appended to body, not to Chaster's row list, on purpose: this
		// element never becomes a sibling of the rows React manages, so
		// there's nothing for its reconciliation to trip over.
		document.body.appendChild(wheelReorderIndicator);
		return wheelReorderIndicator;
	}

	function showWheelReorderIndicator(row, before) {
		const indicator = getWheelReorderIndicator();
		const rect = row.getBoundingClientRect();
		indicator.style.left = rect.left + "px";
		indicator.style.width = rect.width + "px";
		indicator.style.top = (before ? rect.top - 2 : rect.bottom - 2) + "px";
		indicator.style.display = "block";
	}

	function hideWheelReorderIndicator() {
		if (wheelReorderIndicator) wheelReorderIndicator.style.display = "none";
	}

	function injectDragHandles(modal) {
		getSegmentRows(modal).forEach((row) => {
			if (!row.querySelector(".wof-drag-handle")) {
				const handle = document.createElement("span");
				handle.className = "wof-drag-handle";
				handle.textContent = "⋮⋮";
				handle.title = "Drag to reorder";
				row.insertBefore(handle, row.firstChild);
			}

			if (row.dataset.wofDragWired) return;
			row.dataset.wofDragWired = "1";
			row.draggable = true;

			row.addEventListener("dragstart", (e) => {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", String(getSegmentRows(modal).indexOf(row)));
				row.classList.add("wof-dragging");
			});

			row.addEventListener("dragend", () => {
				row.classList.remove("wof-dragging");
				hideWheelReorderIndicator();
			});

			row.addEventListener("dragover", (e) => {
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				const rect = row.getBoundingClientRect();
				const before = e.clientY < rect.top + rect.height / 2;
				row.dataset.wofDropBefore = before ? "1" : "0";
				showWheelReorderIndicator(row, before);
			});

			row.addEventListener("drop", (e) => {
				e.preventDefault();
				hideWheelReorderIndicator();
				const sourceIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
				const rowIndex = getSegmentRows(modal).indexOf(row);
				if (rowIndex < 0) return;
				const before = row.dataset.wofDropBefore === "1";
				// Expressed in the row list's original (pre-removal)
				// numbering, reorderSegments corrects for the shift caused
				// by removing the dragged item itself.
				const destIndexOriginal = before ? rowIndex : rowIndex + 1;
				reorderSegments(modal, sourceIndex, destIndexOriginal);
			});
		});
	}

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

	/*
	 * Canvas patch, makes the wheel actually draw the saved colors.
	 *
	 * Chaster's draw loop is: clearRect, then for each slice in display
	 * order: [set fillStyle, arc, fill()] and, only when the slice is wide
	 * enough (12 degrees or more, or all weights equal), [fillText]. With
	 * weights on, small slices skip their label, so counting fillStyle
	 * assignments no longer lines up with slices. Counting fill() calls
	 * does, since fill() is only ever used for slices.
	 *
	 * Display order isn't config order either once "Show segments in a
	 * random order" is on. The wheel component keeps its shuffled order in
	 * a { source, order } state hook, so that's read from the React fiber
	 * once per frame (at clearRect) along with the raw config segments.
	 */

	// Per 2d context: { fills, info, colors } for the frame being drawn.
	const wheelFrameState = new WeakMap();

	function readWheelInfo(canvas) {
		const fiber = findFiberUp(canvas, (f) => Array.isArray(f.memoizedProps?.extension?.config?.segments), 15);
		if (!fiber) return null;
		const config = fiber.memoizedProps.extension.config;
		const raw = config.segments;

		let order = null;
		for (let hook = fiber.memoizedState, n = 0; hook && n < 40; hook = hook.next, n++) {
			const s = hook.memoizedState;
			if (s && Array.isArray(s.order) && Array.isArray(s.source)) {
				order = s.order;
				break;
			}
		}
		if (!order || order.length !== raw.length) order = raw.map((_, i) => i);

		const segments = order.map((i) => raw[i]);
		// Same rule as Chaster's own: weights only count when enabled.
		const weights = segments.map((s) => (config.weightsEnabled ? s?.weight ?? 1 : 1));
		const total = weights.reduce((a, b) => a + b, 0) || 1;
		const spans = weights.map((w) => (w / total) * 360);
		return { segments, spans };
	}

	const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
	CanvasRenderingContext2D.prototype.clearRect = function (...args) {
		if (isWheelCanvas(this.canvas)) {
			wheelFrameState.set(this, { fills: 0, info: readWheelInfo(this.canvas), colors: loadColors() });
		}
		return originalClearRect.apply(this, args);
	};

	const originalFill = CanvasRenderingContext2D.prototype.fill;
	CanvasRenderingContext2D.prototype.fill = function (...args) {
		if (isWheelCanvas(this.canvas)) {
			const state = wheelFrameState.get(this);
			if (state) {
				const raw = state.info?.segments[state.fills];
				state.fills++;
				const override = raw && state.colors[rawSegmentIdentity(raw)];
				if (override) this.fillStyle = override;
			}
		}
		return originalFill.apply(this, args);
	};

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
	 *
	 * With weights, each wedge has its own angle, so the angle comes from
	 * the slice that was just filled rather than 360 / segment count.
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

	function fitSliceText(ctx, text, canvasWidth, sliceAngle) {
		// Past a half circle the chord starts shrinking again, but the
		// label only needs the width of a half circle at most.
		const angle = Math.min(sliceAngle, Math.PI);
		const innerBoundRadius = WHEEL_TEXT_INNER_BOUND_FRACTION * canvasWidth;
		const chordAtInnerBound = 2 * innerBoundRadius * Math.sin(angle / 2);
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
		while (truncated.length > 1 && ctx.measureText(truncated + "…").width > radialBudget) {
			truncated = truncated.slice(0, -1);
		}
		return { fontSize: WHEEL_TEXT_MIN_FONT_PX, text: truncated.length < text.length ? truncated + "…" : truncated };
	}

	const originalFillText = CanvasRenderingContext2D.prototype.fillText;
	CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
		const state = isWheelCanvas(this.canvas) ? wheelFrameState.get(this) : null;
		const spanDeg = state?.info?.spans[state.fills - 1];
		if (!spanDeg) {
			return originalFillText.call(this, text, x, y, maxWidth);
		}

		const anchorRadius = ((WHEEL_TEXT_INNER_BOUND_FRACTION + WHEEL_TEXT_OUTER_BOUND_FRACTION) / 2) * this.canvas.width;
		const fit = fitSliceText(this, text, this.canvas.width, (spanDeg * Math.PI) / 180);

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
