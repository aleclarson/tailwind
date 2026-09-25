const { writeFileSync } = require("fs");

const remRE = /\d?\.?\d+\s*r?em/g;

// Media query features @nativescript/core can evaluate
// (packages/core/css-mediaquery). Anything else in a query drops that
// comma-separated query; when none survive the whole @media block goes.
const supportedMediaFeatures = [
	"width",
	"height",
	"device-width",
	"device-height",
	"orientation",
	"prefers-color-scheme",
];

// rem/em have no meaning inside NS media query lengths — Length.parse treats
// a bare number as dips, so convert to dips (16px basis like declarations).
const mqLengthRE = /(\d?\.?\d+)\s*r?em/g;

function featureIsSupported(name) {
	const base = name.replace(/^(min|max)-/, "");
	return supportedMediaFeatures.includes(base);
}

function toDip(value) {
	return value.replace(mqLengthRE, (match) => `${parseFloat(match) * 16}`);
}

/**
 * Rewrite one "(...)" media feature into NativeScript-parseable colon syntax.
 * Returns an array of feature strings (double-sided ranges split in two), or
 * null when the feature can't be evaluated by core.
 */
function rewriteMediaFeature(inner) {
	inner = inner.trim();

	// (400px <= width < 700px) and (value <= feature <= value)
	let m = inner.match(
		/^([\d.]+[a-z%]*)\s*(<=|<)\s*([a-z-]+)\s*(<=|<)\s*([\d.]+[a-z%]*)$/i,
	);
	if (m) {
		if (!featureIsSupported(m[3])) return null;
		return [`(min-${m[3]}: ${toDip(m[1])})`, `(max-${m[3]}: ${toDip(m[5])})`];
	}

	// (width >= 40rem) / (width < 40rem) — feature-first range
	m = inner.match(/^([a-z-]+)\s*(<=|>=|<|>)\s*([\d.]+[a-z%]*)$/i);
	if (m) {
		if (!featureIsSupported(m[1])) return null;
		// < and > are exclusive; min-/max- are inclusive — near-enough for
		// breakpoint boundaries, and core has no exclusive comparator.
		const prefix = m[2] === ">" || m[2] === ">=" ? "min" : "max";
		return [`(${prefix}-${m[1]}: ${toDip(m[3])})`];
	}

	// (40rem <= width) / (640px > width) — value-first range (invert)
	m = inner.match(/^([\d.]+[a-z%]*)\s*(<=|>=|<|>)\s*([a-z-]+)$/i);
	if (m) {
		if (!featureIsSupported(m[3])) return null;
		const prefix = m[2] === ">" || m[2] === ">=" ? "max" : "min";
		return [`(${prefix}-${m[3]}: ${toDip(m[1])})`];
	}

	// (min-width: 40rem) — colon syntax, core-native
	m = inner.match(/^([a-z-]+)\s*:\s*(.+)$/i);
	if (m) {
		if (!featureIsSupported(m[1])) return null;
		return [`(${m[1]}: ${toDip(m[2])})`];
	}

	// (orientation), (color-gamut) — bare feature
	m = inner.match(/^([a-z-]+)$/i);
	if (m) {
		return featureIsSupported(m[1]) ? [`(${m[1]})`] : null;
	}

	return null;
}

/**
 * Rewrite an @media prelude for NativeScript: range syntax -> colon syntax,
 * rem/em -> dip, and drop queries using features core can't evaluate.
 * Returns the rewritten prelude, or null when nothing survives.
 */
function rewriteMediaPrelude(params) {
	const queries = [];
	for (const query of params.split(",")) {
		const replaced = query.replace(/\(([^()]+)\)/g, (_, inner) => {
			const out = rewriteMediaFeature(inner);
			return out === null ? " __UNSUPPORTED_MEDIA__" : out.join(" and ");
		});
		if (!replaced.includes(" __UNSUPPORTED_MEDIA__")) {
			queries.push(replaced);
		}
	}
	return queries.length ? queries.join(", ") : null;
}

/**
 * Expand :where(...) selectors. A comma inside :where lists alternatives —
 * the old code spliced the raw text back in, turning
 * `.x:where(.ns-dark, .ns-dark *)` into `.x.ns-dark, .ns-dark *` — the second
 * selector matches every descendant of .ns-dark, not just .x. Proper
 * expansion: alternatives without a combinator become extra conditions on
 * the element; alternatives ending in `*` put the element in that ancestor
 * context; alternatives whose last compound is a real condition splice it
 * onto the element.
 */
function expandWhereSelector(selector) {
	const start = selector.indexOf(":where(");
	if (start === -1) return [selector];

	let depth = 1,
		end = -1;
	for (let i = start + 7; i < selector.length; i++) {
		if (selector[i] === "(") depth++;
		else if (selector[i] === ")") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) return [selector];

	const before = selector.slice(0, start);
	const after = selector.slice(end + 1);
	const args = selector.slice(start + 7, end);

	const alts = [];
	depth = 0;
	let last = 0;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "(") depth++;
		else if (args[i] === ")") depth--;
		else if (args[i] === "," && depth === 0) {
			alts.push(args.slice(last, i));
			last = i + 1;
		}
	}
	alts.push(args.slice(last));

	const out = [];
	for (const alt of alts) {
		const a = alt.trim();
		// last compound after a combinator, e.g. ".space-y-reverse > X"
		const m = a.match(/^(.*[>+~\s])\s*([^\s>+~]+)$/);
		if (m) {
			const [, prefix, lastCompound] = m;
			if (lastCompound === "*") {
				out.push(`${prefix.trim()} ${before}${after}`.trim());
			} else {
				out.push(`${prefix.trim()} ${before}${lastCompound}${after}`.trim());
			}
		} else {
			out.push(`${before}${a}${after}`);
		}
	}
	return out;
}

/**
 * Split a shorthand value on whitespace that is not inside parens.
 */
function splitArgs(value) {
	return value.trim().split(/\s+(?![^()]*\))/);
}

/**
 * Tailwind v4 emits CSS logical properties for the px/py/mx/my, space, and
 * divide utilities; @nativescript/core only implements the physical sides.
 * Inline-* maps to left/right, block-* to top/bottom — an LTR reading;
 * RTL apps should override per-direction instead.
 */
const logicalToPhysical = {
	"margin-inline": ["margin-left", "margin-right"],
	"margin-inline-start": ["margin-left"],
	"margin-inline-end": ["margin-right"],
	"margin-block": ["margin-top", "margin-bottom"],
	"margin-block-start": ["margin-top"],
	"margin-block-end": ["margin-bottom"],
	"padding-inline": ["padding-left", "padding-right"],
	"padding-inline-start": ["padding-left"],
	"padding-inline-end": ["padding-right"],
	"padding-block": ["padding-top", "padding-bottom"],
	"padding-block-start": ["padding-top"],
	"padding-block-end": ["padding-bottom"],
	"border-inline-width": ["border-left-width", "border-right-width"],
	"border-inline-start-width": ["border-left-width"],
	"border-inline-end-width": ["border-right-width"],
	"border-inline-color": ["border-left-color", "border-right-color"],
	"border-block-width": ["border-top-width", "border-bottom-width"],
	"border-block-start-width": ["border-top-width"],
	"border-block-end-width": ["border-bottom-width"],
	"border-block-color": ["border-top-color", "border-bottom-color"],
};

/**
 * Tailwind v4 transform utilities set `--tw-translate-*`/`--tw-scale-*` custom
 * properties in the same rule, then apply them via `translate:`/`scale:`
 * shorthand declarations — neither the shorthands nor element-scoped
 * var() resolution exist in core's engine, and per-axis props
 * (translateX/scaleX/scaleY) are animation-only and never apply through
 * the stylesheet. The only door core opens is the `transform:` shorthand
 * via transformConverter — and it needs literal numbers (parseFloat on
 * 'translateX(N)'), so calc()/var() must be resolved here.
 *
 * All transform pieces in a rule are merged into ONE decl: the shorthand
 * resets every axis, so two `transform:` decls in a rule would be
 * last-wins, and per-utility rules can't compose on an element anyway
 * (translate-x-* + scale-* on one view: the later stylesheet rule wins —
 * a core cascade limitation, not something PostCSS can merge).
 */
const transformVarToFn = {
	"--tw-translate-x": "translateX",
	"--tw-translate-y": "translateY",
	"--tw-scale-x": "scaleX",
	"--tw-scale-y": "scaleY",
};

// dip value of 1 × --spacing (theme.css ships --spacing: .25rem → 4)
const rootSpacing = new WeakMap();
const mergedTransformRules = new WeakSet();
function resolveSpacing(root) {
	if (rootSpacing.has(root)) return rootSpacing.get(root);
	let value = 4;
	root.walkDecls("--spacing", (decl) => {
		const n = parseFloat(decl.value);
		if (Number.isNaN(n)) return;
		value = decl.value.includes("rem") || decl.value.includes("em") ? n * 16 : n;
	});
	rootSpacing.set(root, value);
	return value;
}

// Resolve a transform arg to a number for translateX(N)/scaleX(N).
// 'calc(var(--spacing) * 4)' → spacing × 4; '95%' → 0.95 (scale);
// '16px'/'-8'/'1rem' → number (rem → ×16).
function resolveTransformArg(raw, isScale, root) {
	const v = raw.trim();
	const spacingCalc = v.match(/^calc\(var\(--spacing\)\s*\*\s*(-?[\d.]+)\)$/);
	if (spacingCalc) {
		return resolveSpacing(root) * parseFloat(spacingCalc[1]);
	}
	if (v.includes("var(")) return null;
	const plainCalc = v.match(/^calc\((-?[\d.]+)\s*([*+/])\s*(-?[\d.]+)\)$/);
	if (plainCalc) {
		const [, a, op, b] = plainCalc;
		const x = parseFloat(a);
		const y = parseFloat(b);
		return op === "*" ? x * y : op === "+" ? x + y : x / y;
	}
	const n = parseFloat(v);
	if (Number.isNaN(n)) return null;
	if (isScale) return v.endsWith("%") ? n / 100 : n;
	return v.endsWith("rem") || v.endsWith("em") ? n * 16 : n;
}

function isSupportedProperty(prop, val = null) {
	const rules = supportedProperties[prop];
	if (!rules) return false;

	if (val) {
		if (unsupportedValues.some((unit) => val.endsWith(unit))) {
			return false;
		}

		if (Array.isArray(rules)) {
			return rules.includes(val);
		}
	}

	return true;
}

function isSupportedSelector(selector) {
	const hasUnsupportedPseudoSelector = unsupportedPseudoSelectors.some(
		(pseudo) => selector.includes(pseudo)
	);

	return !hasUnsupportedPseudoSelector;
}

function isPlaceholderPseudoSelector(selector) {
	return selector.includes("::placeholder");
}

/**
 * @param {@} options
 * @returns {import('postcss').Plugin}
 */
module.exports = (options = { debug: false }) => {
	return {
		postcssPlugin: "postcss-nativescript",
		AtRule: {
			// NativeScript's media query engine covers width/height/
			// device-*/orientation/prefers-color-scheme in colon syntax.
			// Rewrite Tailwind's range syntax into it and drop only the
			// queries that use features core can't evaluate.
			media(mediaAtRule) {
				const rewritten = rewriteMediaPrelude(mediaAtRule.params);
				if (rewritten === null) {
					return mediaAtRule.remove();
				}
				mediaAtRule.params = rewritten;
			},

			// Flatten @supports rules instead of removing them.
			// NativeScript Core 8.9.1+ supports color-mix() (see NativeScript/NativeScript#10718),
			// and Tailwind v4 wraps opacity modifier utilities in @supports(color: color-mix(...)).
			supports(supportsAtRule) {
				if (!supportsAtRule.nodes || !supportsAtRule.nodes.length) {
					return supportsAtRule.remove();
				}
				supportsAtRule.replaceWith(...supportsAtRule.nodes);
			},

			// remove @property rules
			// Tailwind v4 uses these for custom property definitions
			property(propertyAtRule) {
				propertyAtRule.remove();
			},

			// Tailwind v4 wraps most output in @layer blocks (base/theme/utilities).
			// NativeScript's CSS engine does not implement CSS Cascade Layers,
			// so rules inside @layer would otherwise be ignored.
			//
			// Flatten those layers by lifting their child rules into the parent,
			// preserving order so specificity/cascade still work as expected.
			layer(layerAtRule) {
				if (!layerAtRule.nodes || !layerAtRule.nodes.length) {
					return layerAtRule.remove();
				}

				layerAtRule.replaceWith(...layerAtRule.nodes);
			},
		},
		// Uncomment to debug the final output
		// OnceExit(rule) {
		//   writeFileSync('./tailwind-output.css', rule.toString());
		// },
		Rule(rule) {
			// remove rules with empty selectors (can happen after stripping ::placeholder)
			if (!rule.selector || rule.selector.trim() === '') {
				return rule.remove();
			}

			// remove empty rules
			if (rule.nodes.length === 0) {
				return rule.remove();
			}

			// remove rules that contain CSS nesting (& selector) - not supported in NativeScript
			// Tailwind v4 uses nesting for variants like dark mode and space utilities
			if (rule.selector.includes('&')) {
				return rule.remove();
			}

			// replace :root and :host pseudo selector, introduced in Tailwind 4+ with .ns-root for var handling.
			if (rule.selector.includes(":root") || rule.selector.includes(":host")) {
				const rootClasses = '.ns-root, .ns-modal';
				rule.selectors = rule.selectors.map((selector) =>
					selector.replace(/:root/, rootClasses).replace(/:host/, rootClasses)
				);
			}

			// remove rules with unsupported selectors
			if (!isSupportedSelector(rule.selector)) {
				return rule.remove();
			}

			// convert ::placeholder pseudo selector
			// to use placeholder-color declaration
			if (isPlaceholderPseudoSelector(rule.selector)) {
				const placeholderSelectors = [];
				rule.selectors.forEach((selector) => {
					if (isPlaceholderPseudoSelector(selector)) {
						const cleaned = selector.replace(/::placeholder/g, "").trim();
						// Only add non-empty selectors
						if (cleaned) {
							placeholderSelectors.push(cleaned);
						}
					}
				});
				// If all selectors became empty, remove the rule
				if (placeholderSelectors.length === 0) {
					return rule.remove();
				}
				if (placeholderSelectors.length) {
					rule.selectors = placeholderSelectors;
					rule.walkDecls((decl) => {
						if (decl.prop === "color") {
							decl.replaceWith(decl.clone({ prop: "placeholder-color" }));
						}
					});
				}
				// rule.selector.replace('::placeholder', '')
			}

			// expand :where() pseudo selectors — NS can't parse them, and
			// comma alternatives need per-alternative expansion (Tailwind
			// v4 emits them for dark: and space-*/divide-* variants).
			while (rule.selectors.some((s) => s.includes(":where("))) {
				rule.selectors = rule.selectors.flatMap(expandWhereSelector);
			}

			// replace space and divide selectors to use a simpler selector that works in ns (v4 and newer)
			if (rule.selector.includes(":not(:last-child)")) {
				rule.selectors = rule.selectors.map((selector) => {
					return selector.replace(":not(:last-child)", "* + *");
				});
			}

			// replace space and divide selectors to use a simpler selector that works in ns (older versions)
			if (rule.selector.includes(":not([hidden]) ~ :not([hidden])")) {
				rule.selectors = rule.selectors.map((selector) => {
					return selector.replace(":not([hidden]) ~ :not([hidden])", "* + *");
				});
			}
		},
		Declaration(decl) {
			// tailvind v4 changed how the divide and space utilities work, now we need to set two variables called
			// --tw-divide-x-reverse and --tw-divide-y-reverse but for them to work we need to remove the variable
			// declarations from the divide and space utilities classes
			const broken = /--tw-(divide|space)-[xy]-reverse/g;

			if (decl.prop?.match(broken) && decl.parent.selector?.match(/\.(divide|space)-[xy]/)) {
				return decl.remove();
			}

			// invalid with core 8.8+ at moment
			// Note: could be supported at somepoint
			if (decl.prop === "placeholder-color" && decl.value?.includes("color-mix")) {
				return decl.remove();
			}

			// invalid with core 8.8+ at moment
			// Note: could be supported at somepoint
			if (decl.value?.includes("currentColor")) {
				return decl.remove();
			}

			// logical -> physical property sides (px-*/py-*/mx-*/my-*,
			// space-*/divide-*, ps-*/pe-*/ms-*/me-*, border-x/y on v4).
			// Inserted declarations are re-visited by this same handler.
			const physical = logicalToPhysical[decl.prop];
			if (physical) {
				const clones = physical.map((prop) =>
					decl.clone({ prop }),
				);
				decl.parent.insertAfter(decl, clones);
				return decl.remove();
			}

			// replace vertical-align: middle
			// with    vertical-align: center
			if (decl.prop === "vertical-align") {
				switch (decl.value) {
					case "middle":
						return decl.replaceWith(decl.clone({ value: "center" }));
				}
			}

			// declarations that define unsupported variables/rules
			if (
				[
					"tw-ring",
					"tw-shadow",
					"tw-ordinal",
					"tw-slashed-zero",
					"tw-numeric",
				].some((varName) => decl.prop.startsWith(`--${varName}`))
			) {
				return decl.remove();
			}

			// Convert em/rem values to device pixel values
			// assuming 16 as the basis for rem and
			// treating em as rem
			if (decl.value.includes("rem") || decl.value.includes("em")) {
				decl.value = decl.value.replace(remRE, (match, offset, value) => {
					const converted = "" + parseFloat(match) * 16;

					options.debug &&
						console.log("replacing r?em value", {
							match,
							offset,
							value,
							converted,
						});

					return converted;
				});
				options.debug &&
					console.log({
						final: decl.value,
					});
			}

			// Merge --tw-translate-*/--tw-scale-* + translate:/scale: into a
			// single `transform:` shorthand — the only path that applies
			// transforms via stylesheet on core.
			if (
				decl.prop in transformVarToFn ||
				decl.prop === "translate" ||
				decl.prop === "scale"
			) {
				const rule = decl.parent;
				if (mergedTransformRules.has(rule)) {
					return decl.remove();
				}
				mergedTransformRules.add(rule);

				const parts = [];
				const removals = [];
				for (const sib of rule.nodes ?? []) {
					if (sib.type !== "decl") continue;
					const fn = transformVarToFn[sib.prop];
					if (fn) {
						const v = resolveTransformArg(sib.value, fn.startsWith("scale"), decl.root());
						if (v != null) parts.push(`${fn}(${v})`);
						removals.push(sib);
					} else if (sib.prop === "translate" || sib.prop === "scale") {
						// literal-args shorthand (hand CSS) unrolls into functions;
						// var(--tw-*) args are covered by the --tw-* decls above
						const isS = sib.prop === "scale";
						if (sib.value.trim() !== "none" && !sib.value.includes("var(")) {
							const [x, y] = splitArgs(sib.value);
							const xv = resolveTransformArg(x, isS, decl.root());
							if (xv != null) parts.push(`${isS ? "scaleX" : "translateX"}(${xv})`);
							const yv = y ?? (isS ? x : undefined);
							const yr =
								yv !== undefined ? resolveTransformArg(yv, isS, decl.root()) : null;
							if (yr != null) parts.push(`${isS ? "scaleY" : "translateY"}(${yr})`);
						}
						removals.push(sib);
					}
				}
				if (parts.length) {
					rule.insertBefore(decl, decl.clone({ prop: "transform", value: parts.join(" ") }));
				}
				for (const node of removals) {
					if (node !== decl) node.remove();
				}
				return decl.remove();
			}

			// remove unsupported properties
			if (
				!decl.prop.startsWith("--") &&
				!isSupportedProperty(decl.prop, decl.value)
			) {
				// options.debug && console.log('removing ', decl.prop, decl.value)
				return decl.remove();
			}
		},
	};
};
module.exports.postcss = true;

// Property allowlist — kept in sync with the CssProperty registry in
// @nativescript/core (packages/core ui/styling/style-properties.ts plus
// per-view registrations). Properties core parses but that aren't valid
// Tailwind output are still listed so hand-written CSS survives the pass.
const supportedProperties = {
	"align-content": true,
	"align-items": true,
	"align-self": true,
	"android-content-inset": true,
	"android-content-inset-left": true,
	"android-content-inset-right": true,
	"android-selected-tab-highlight-color": true,
	"android-status-bar-background": true,
	"android-elevation": true,
	"android-dynamic-elevation-offset": true,
	animation: true,
	"animation-delay": true,
	"animation-direction": true,
	"animation-duration": true,
	"animation-fill-mode": true,
	"animation-iteration-count": true,
	"animation-name": true,
	"animation-timing-function": true,
	background: true,
	"background-color": true,
	"background-image": true,
	"background-position": true,
	"background-repeat": ["repeat", "repeat-x", "repeat-y", "no-repeat"],
	"background-size": true,
	"border-bottom-color": true,
	"border-bottom-left-radius": true,
	"border-bottom-right-radius": true,
	"border-bottom-width": true,
	"border-color": true,
	"border-left-color": true,
	"border-left-width": true,
	"border-radius": true,
	"border-right-color": true,
	"border-right-width": true,
	"border-top-color": true,
	"border-top-left-radius": true,
	"border-top-right-radius": true,
	"border-top-width": true,
	"border-width": true,
	"box-shadow": true,
	"clip-path": true,
	color: true,
	"column-gap": true,
	"corner-shape": ["squircle", "round"],
	direction: ["ltr", "rtl"],
	flex: true,
	"flex-flow": true,
	"flex-grow": true,
	"flex-direction": true,
	"flex-shrink": true,
	"flex-wrap": true,
	"flex-wrap-before": true,
	font: true,
	"font-family": true,
	"font-size": true,
	"font-style": ["italic", "normal"],
	"font-weight": true,
	"font-variation-settings": true,
	gap: true,
	height: true,
	"highlight-color": true,
	"horizontal-align": ["left", "center", "right", "stretch"],
	"icon-font-family": true,
	"justify-content": true,
	"justify-items": true,
	"justify-self": true,
	"letter-spacing": true,
	"line-height": true,
	margin: true,
	"margin-bottom": true,
	"margin-left": true,
	"margin-right": true,
	"margin-top": true,
	"margin-block": true,
	"margin-block-start": true,
	"margin-block-end": true,
	"margin-inline": true,
	"margin-inline-start": true,
	"margin-inline-end": true,
	"max-height": true,
	"max-lines": true,
	"max-width": true,
	"min-height": true,
	"min-width": true,
	"off-background-color": true,
	opacity: true,
	order: true,
	padding: true,
	"padding-block": true,
	"padding-bottom": true,
	"padding-inline": true,
	"padding-left": true,
	"padding-right": true,
	"padding-top": true,
	perspective: true,
	"place-content": true,
	"placeholder-color": true,
	"place-items": true,
	"place-self": true,
	rotate: true,
	rotatex: true,
	rotatey: true,
	"row-gap": true,
	// core registers these camelCase cssNames (style-properties.ts)
	scaleX: true,
	scaleY: true,
	"selected-background-color": true,
	"selected-tab-text-color": true,
	"selected-text-color": true,
	"separator-color": true,
	"status-bar-style": true,
	"tab-background-color": true,
	"tab-text-color": true,
	"tab-text-font-size": true,
	"text-transform": true,
	"text-align": ["left", "center", "right"],
	"text-decoration": ["none", "line-through", "underline"],
	"text-overflow": ["clip", "ellipsis"],
	"text-shadow": true,
	"text-stroke": true,
	"text-transform": ["none", "capitalize", "uppercase", "lowercase"],
	"tint-color": true,
	transform: true,
	translateX: true,
	translateY: true,
	"vertical-align": ["top", "center", "middle", "bottom", "stretch"],
	visibility: ["visible", "hidden", "collapse", "collapsed"],
	"white-space": ["normal", "nowrap", "wrap"],
	width: true,
	"z-index": true,
};

const unsupportedPseudoSelectors = [":focus-within", ":hover"];
const unsupportedValues = ["max-content", "min-content", "vh", "vw"];
