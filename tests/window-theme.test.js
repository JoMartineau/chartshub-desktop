const test = require('node:test');
const assert = require('node:assert/strict');
const { windowTheme } = require('../window-theme');
test('rejects invalid theme payloads', () => {
 for (const value of [null, {}, {mode:'auto',accent:'#ff00ff'}, {mode:'dark',accent:'red'}, {mode:'light',accent:'#123456;'}]) assert.equal(windowTheme(value), null);
});
test('keeps window controls readable and applies accent in both modes', () => {
 const dark = windowTheme({mode:'dark',accent:'#FF00FF'});
 const light = windowTheme({mode:'light',accent:'#FF00FF'});
 assert.equal(dark.accent, '#ff00ff');
 assert.equal(dark.symbolColor, '#eef3ff');
 assert.equal(light.symbolColor, '#17263e');
 assert.notEqual(dark.color, light.color);
 assert.notEqual(dark.color, windowTheme({mode:'dark',accent:'#00ff00'}).color);
});
