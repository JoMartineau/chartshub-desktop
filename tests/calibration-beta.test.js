'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GameplayControls } = require('../companion/ui/gameplay-controls.js');
const { prototype } = GameplayControls;

test('Feedback remains available in separate Calibration and Stream sections and supports legacy single-root use', () => {
    const node = () => ({ textContent: '', hidden: true, classList: { remove() {} } });
    const state = { feedback: node(), summaryFeedback: node(), feedbackNodes: prototype.feedbackNodes, tr: (fr, en) => en };
    prototype.showFeedback.call(state, 'Action terminée.', 'Action completed.');
    assert.equal(state.feedback.textContent, 'Action completed.');
    assert.equal(state.summaryFeedback.textContent, 'Action completed.');
    assert.equal(state.feedback.hidden, false);
    assert.equal(state.summaryFeedback.hidden, false);
    delete state.summaryFeedback;
    state.tr = fr => fr;
    prototype.showFeedback.call(state, 'Essai conservé.', 'Trial kept.');
    assert.equal(state.feedback.textContent, 'Essai conservé.');
});

test('A failed calibration command cannot restore the previous successful message on its final render', async () => {
    const node = () => ({ textContent: '', hidden: true, classList: { remove() {}, add() {} } });
    const state = {
        feedback: node(),
        summaryFeedback: node(),
        feedbackNodes: prototype.feedbackNodes,
        tr: (fr, en) => en,
        command: async () => ({ ok: false, error: 'Measures unavailable' }),
        render() {
            if (this.feedbackMessage) {
                for (const feedback of this.feedbackNodes()) feedback.textContent = this.tr(...this.feedbackMessage);
            }
        },
    };
    prototype.showFeedback.call(state, 'Action terminée.', 'Action completed.');
    await prototype.run.call(state, 'telemetry.calibrationStart', {});
    assert.equal(state.feedback.textContent, 'Measures unavailable');
    assert.equal(state.summaryFeedback.textContent, 'Measures unavailable');
    assert.equal(state.feedbackMessage, null);
    assert.equal(state.busy, false);
});
