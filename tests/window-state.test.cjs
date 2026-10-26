const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const context = { module: { exports: {} }, require: name => name === 'obsidian'
  ? { Plugin: class {}, Notice: class {}, Platform: {} } : require(name) };
vm.runInNewContext(script, context);
const { fitBounds, normalizeSettings } = context.module.exports.windowUtils;
const area = { x: 0, y: 0, width: 1536, height: 864 };

test('new window stays inside the working area and avoids the taskbar', () => {
  const b = fitBounds(null, area);
  assert.equal(b.width, 400);
  assert.ok(b.x + b.width <= area.width - 16);
  assert.ok(b.y + b.height <= area.height - 16);
});
test('off-screen geometry returns to the remaining display', () => {
  const b = fitBounds({ x: -5000, y: 4000, width: 4000, height: 2000 }, area);
  assert.ok(b.x >= 16 && b.y >= 16);
  assert.ok(b.x + b.width <= area.width - 16);
  assert.ok(b.y + b.height <= area.height - 16);
});
test('negative-coordinate monitor and small working areas are supported', () => {
  for (const work of [{ x: -1920, y: -200, width: 1920, height: 1040 }, { x: 0, y: 0, width: 300, height: 400 }]) {
    const b = fitBounds(null, work);
    assert.ok(b.x >= work.x && b.y >= work.y);
    assert.ok(b.x + b.width <= work.x + work.width);
    assert.ok(b.y + b.height <= work.y + work.height);
  }
});
test('persisted opacity is bounded and damaged geometry is ignored', () => {
  assert.equal(normalizeSettings().opacity, 0.93);
  assert.equal(normalizeSettings({ opacity: 0.01 }).opacity, 0.01);
  assert.equal(normalizeSettings({ opacity: 0 }).opacity, 0);
  assert.equal(normalizeSettings({ opacity: -0.2 }).opacity, 0);
  assert.equal(normalizeSettings({ opacity: 2 }).opacity, 1);
  assert.equal(normalizeSettings({ bounds: { x: NaN } }).bounds, null);
  assert.equal(normalizeSettings({ pinned: 'yes' }).pinned, false);
});
