// node --test test/parity.test.mjs
// Exercises removeUnsupported against authored CSS shaped like Tailwind v4
// output — no tailwindcss dependency required to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const postcss = require('postcss');
const plugin = require('../src/removeUnsupported.js');

async function run(css) {
	const res = await postcss([plugin()]).process(css, { from: undefined });
	return res.css;
}

test('keeps visibility:hidden — collapse removes from layout, hidden does not', async () => {
	assert.equal(await run('.invisible{visibility:hidden}'), '.invisible{visibility:hidden}');
});

test('rewrites range-syntax @media to core-parseable colon form with dips', async () => {
	assert.equal(
		await run('@media (width >= 40rem){.x{gap:8px}}'),
		'@media (min-width: 640){.x{gap:8px}}',
	);
	assert.equal(
		await run('@media (width < 48rem){.x{gap:8px}}'),
		'@media (max-width: 768){.x{gap:8px}}',
	);
});

test('keeps colon-syntax and supported features; drops unsupported queries only', async () => {
	assert.equal(
		await run('@media (orientation: portrait){.x{gap:8px}}'),
		'@media (orientation: portrait){.x{gap:8px}}',
	);
	assert.equal(
		await run('@media (prefers-color-scheme: dark){.x{color:#fff}}'),
		'@media (prefers-color-scheme: dark){.x{color:#fff}}',
	);
	assert.equal(await run('@media (hover: hover){.x{color:red}}'), '');
	// comma lists: keep the evaluable query, drop the rest
	assert.equal(
		await run('@media (width >= 40rem), (hover: hover){.x{gap:8px}}'),
		'@media (min-width: 640){.x{gap:8px}}',
	);
});

test('allowlist covers properties @nativescript/core parses', async () => {
	const cases = {
		gap: '8px', 'row-gap': '8px', 'column-gap': '8px',
		'white-space': 'nowrap', 'text-overflow': 'ellipsis',
		'max-width': '100px', 'max-height': '100px',
		perspective: '100', direction: 'rtl',
	};
	for (const [prop, value] of Object.entries(cases)) {
		assert.match(await run(`.x{${prop}:${value}}`), new RegExp(`${prop}:${value}`), prop);
	}
});

test('unrolls translate/scale shorthands onto core per-axis properties', async () => {
	assert.equal(
		await run('.x{--tw-translate-x:4;translate:var(--tw-translate-x) var(--tw-translate-y)}'),
		'.x{--tw-translate-x:4;translateX:var(--tw-translate-x, 0);translateY:var(--tw-translate-y, 0)}',
	);
	assert.equal(
		await run('.x{--tw-scale-x:95%;--tw-scale-y:95%;scale:var(--tw-scale-x) var(--tw-scale-y)}'),
		'.x{--tw-scale-x:95%;--tw-scale-y:95%;scaleX:var(--tw-scale-x, 1);scaleY:var(--tw-scale-y, 1)}',
	);
});

test('rewrites logical properties to physical sides', async () => {
	assert.equal(
		await run('.x{padding-inline:4px;padding-block:8px;margin-inline-end:2px}'),
		'.x{padding-left:4px;padding-right:4px;padding-top:8px;padding-bottom:8px;margin-right:2px}',
	);
	assert.equal(
		await run('.x > * + *{margin-inline-start:4px;border-inline-start-width:1px}'),
		'.x > * + *{margin-left:4px;border-left-width:1px}',
	);
});

test('expands :where comma alternatives onto the subject, not the whole tree', async () => {
	assert.equal(
		await run('.dark\\:x:where(.ns-dark, .ns-dark *){color:#fff}'),
		'.dark\\:x.ns-dark, .ns-dark .dark\\:x{color:#fff}',
	);
	assert.equal(
		await run(':where(.space-y > :not(:last-child)){margin-bottom:4px}'),
		'.space-y > * + *{margin-bottom:4px}',
	);
});
