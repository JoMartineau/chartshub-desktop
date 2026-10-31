/** Measurements come from the local connector, never from a percentage or a screenshot. */
export class GameplayControls {
    constructor({ root, command }) {
        this.root = root;
        this.command = command;
        this.language = 'fr';
        this.snapshot = null;
        this.busy = false;
        this.dirty = false;
        this.disposed = false;
        this.labels = [];
        this.listeners = [];
        this.node = (tag, parent = root, className = '') => { const e = root.ownerDocument.createElement(tag); e.className = className; parent.append(e); return e; };
        this.label = (node, fr, en) => { this.labels.push([node, fr, en]); return node; };
        this.text = (tag, fr, en, parent = root) => this.label(this.node(tag, parent), fr, en);
        this.listen = (node, event, fn) => { node.addEventListener(event, fn); this.listeners.push(() => node.removeEventListener(event, fn)); };
        const field = (parent, fr, en) => { const label = this.node('label', parent, 'performance-field'); this.text('span', fr, en, label); const input = this.node('input', label); input.type = 'number'; return input; };
        const button = (parent, fr, en, fn, primary = false) => { const b = this.text('button', fr, en, parent); b.type = 'button'; b.className = 'button' + (primary ? '' : ' secondary'); this.listen(b, 'click', fn); return b; };
        const heading = this.node('div', root, 'card-heading'), title = this.node('div', heading);
        this.text('h2', 'Mesures du jeu et widgets', 'Gameplay measurements and widgets', title);
        this.text('p', 'Accuracy, combo, progression et objectifs de session.', 'Accuracy, combo, progress and session goals.', title);
        const enable = this.node('label', heading, 'performance-enable');
        this.enabled = this.node('input', enable);
        this.enabled.type = 'checkbox';
        this.text('span', 'Recevoir les mesures', 'Receive measurements', enable);
        this.listen(this.enabled, 'change', () => void this.run('telemetry.enabled', { enabled: this.enabled.checked }));
        this.status = this.node('p', root, 'performance-status');
        this.status.setAttribute('role', 'status');
        this.text('p', 'Les mesures nécessitent le connecteur local correspondant à votre version de Clone Hero. Aucun changement de réglage du jeu n’est appliqué par ChartsHub.', 'Measurements require the local connector for your Clone Hero version. ChartsHub does not change game settings.');
        const grid = this.node('dl', root, 'performance-metrics');
        this.metrics = {};
        for (const [key, fr, en] of [['lastOffsetMs', 'Dernier décalage', 'Last offset'], ['meanOffsetMs', 'Moyenne signée', 'Signed mean'], ['meanAbsoluteOffsetMs', 'Écart absolu moyen', 'Mean absolute offset'], ['standardDeviationMs', 'Dispersion', 'Deviation'], ['withinWindowPercent', 'Dans la fenêtre', 'Inside window'], ['sampleCount', 'Jugements mesurés', 'Measured judgments']]) {
            const pair = this.node('div', grid);
            this.text('dt', fr, en, pair);
            this.metrics[key] = this.node('dd', pair);
        }
        this.coverage = this.node('p', root, 'helper-text');
        this.form = this.node('form', root, 'performance-settings');
        this.window = field(this.form, 'Fenêtre ± (ms)', 'Window ± (ms)');
        Object.assign(this.window, { min: '1', max: '200', step: '1' });
        const goal = this.node('label', this.form, 'performance-field');
        this.text('span', 'Objectif de session', 'Session goal', goal);
        this.goal = this.node('select', goal);
        for (const [value, fr, en] of [['songs', 'Morceaux terminés', 'Completed songs'], ['fc', 'FC', 'FC'], ['minutes', 'Minutes', 'Minutes']]) {
            const option = this.text('option', fr, en, this.goal);
            option.value = value;
        }
        this.target = field(this.form, 'Cible', 'Target');
        Object.assign(this.target, { min: '1', max: '10000', step: '1' });
        this.save = this.text('button', 'Enregistrer', 'Save', this.form);
        this.save.type = 'submit';
        this.save.className = 'button secondary';
        this.listen(this.form, 'input', () => { this.dirty = true; });
        this.listen(this.goal, 'change', () => { this.dirty = true; this.target.max = this.goal.value === 'minutes' ? '1440' : '10000'; });
        this.listen(this.form, 'submit', event => { event.preventDefault(); if (this.form.reportValidity())
            void this.run('telemetry.configure', { windowMs: Number(this.window.value), goal: { kind: this.goal.value, target: Number(this.target.value) } }, true); });
        const actions = this.node('div', root, 'performance-actions');
        this.add = button(actions, 'Ajouter les 7 widgets à OBS', 'Add all 7 widgets to OBS', () => void this.run('telemetry.widgets'), true);
        this.reset = button(actions, 'Nouvelle session', 'New session', () => void this.run('telemetry.sessionReset'));
        button(actions, 'Taille et valeurs Accuracy', 'Accuracy size and fields', () => {
            const input = root.ownerDocument.querySelector('#widget-font-size-gameplay-accuracy');
            input?.closest('.widget-setting')?.scrollIntoView({ block: 'center', behavior: 'instant' });
            input?.focus({ preventScroll: true });
        });
        this.text('p', 'Les widgets utilisent la source Navigateur OBS ci-dessous. Activez les éléments souhaités dans la liste des widgets ; leurs couleurs et positions restent modifiables.', 'Widgets use the OBS Browser source below. Enable the items you want in the widget list; colors and positions remain editable.');
        this.availability = this.node('ul', root, 'performance-availability');
        const details = this.node('details', root, 'performance-calibration');
        this.text('summary', 'Aide à la calibration audio et vidéo', 'Audio and video calibration helper', details);
        this.text('p', 'Dans Clone Hero : Réglages → Gameplay → Calibration. Terminez les essais audio et vidéo séparément : leurs résultats apparaissent ici quand le connecteur les prend en charge.', 'In Clone Hero: Settings → Gameplay → Calibration. Complete audio and video separately: their results appear here when supported by the connector.', details);
        const native = this.node('div', details, 'performance-calibration-results');
        this.nativeResults = {};
        for (const [key, fr, en] of [['audio', 'Délai audio', 'Audio delay'], ['video', 'Délai vidéo', 'Video delay']]) {
            const card = this.node('section', native, 'performance-calibration-result');
            card.dataset.stage = key;
            this.text('h3', fr, en, card);
            const value = this.node('p', card, 'performance-calibration-result-value');
            const state = this.node('p', card, 'helper-text');
            value.setAttribute('role', 'status');
            this.nativeResults[key] = { value, state };
        }
        this.text('p', 'La valeur affichée a été retenue lors du dernier essai de l’outil de calibration du jeu, en millisecondes. C’est une valeur complète, pas un décalage à ajouter à votre réglage. Elle ne suit pas vos modifications manuelles ultérieures. ChartsHub ne modifie aucun réglage.', 'The displayed value was retained in the last trial of the game’s calibration tool, in milliseconds. It is an absolute value, not an offset to add to your setting. It does not track later manual changes. ChartsHub does not change any settings.', details);
        this.text('p', 'Testez d’abord l’audio avec l’outil de calibration de Clone Hero, puis vérifiez séparément la vidéo avec la fenêtre de frappe visible. Une seule moyenne ne permet pas de déduire les deux réglages.', 'Test audio first with Clone Hero’s calibration tool, then check video separately with the hit window visible. A single mean cannot determine both settings.', details);
        this.text('h3', 'Comparer mes essais', 'Compare my trials', details);
        this.text('p', 'Changez un seul réglage dans le jeu, notez sa valeur, puis mesurez au moins 30 frappes continues sur le même passage et à la même vitesse. Ces essais comparent votre jeu réel ; ils ne remplacent pas la calibration native.', 'Change one game setting, enter its value, then measure at least 30 continuous hits on the same passage at the same speed. These trials compare actual playing; they do not replace native calibration.', details);
        const calibration = this.node('div', details, 'performance-settings'), stage = this.node('label', calibration, 'performance-field');
        this.text('span', 'Réglage testé', 'Setting tested', stage);
        this.stage = this.node('select', stage);
        for (const [value, fr, en] of [['audio', 'Audio', 'Audio'], ['video', 'Vidéo', 'Video']]) {
            const option = this.text('option', fr, en, this.stage);
            option.value = value;
        }
        const source = this.node('label', calibration, 'performance-field');
        this.text('span', 'Source de l’essai', 'Trial source', source);
        this.source = this.node('select', source);
        for (const [value, fr, en] of [['tool', 'Outil de calibration natif', 'Native calibration tool'], ['gameplay', 'Frappes pendant une chart', 'Hits during a chart']]) {
            const option = this.text('option', fr, en, this.source);
            option.value = value;
        }
        this.setting = field(calibration, 'Valeur dans le jeu (ms)', 'In-game value (ms)');
        Object.assign(this.setting, { min: '-1000', max: '1000', step: 'any', value: '0' });
        this.start = button(calibration, 'Démarrer un essai', 'Start trial', () => { if (this.setting.reportValidity())
            void this.run('telemetry.calibrationStart', { stage: this.stage.value, settingMs: Number(this.setting.value), source: this.source.value }); });
        this.listen(this.source, 'change', () => this.render());
        this.finish = button(calibration, 'Terminer et comparer', 'Finish and compare', () => void this.run('telemetry.calibrationFinish'));
        this.trial = this.node('p', details, 'helper-text');
        this.trial.setAttribute('role', 'status');
        this.trials = this.node('ol', details, 'performance-trials');
        button(details, 'Guide officiel Clone Hero', 'Official Clone Hero guide', () => void this.run('telemetry.guide'));
        this.feedback = this.node('p', root, 'performance-feedback');
        this.feedback.hidden = true;
        this.feedback.setAttribute('role', 'status');
        this.render();
    }
    tr(fr, en) { return this.language === 'en' ? en : fr; }
    format(value, decimals = 1) { return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(this.language, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value) : '—'; }
    async run(name, payload, clear = false) {
        if (this.busy || this.disposed)
            return;
        this.busy = true;
        this.feedback.hidden = true;
        this.render();
        try {
            const result = await this.command(name, payload);
            if (this.disposed)
                return;
            if (!result?.ok)
                throw Error(result?.error || this.tr('Cette action n’a pas pu être appliquée.', 'This action could not be applied.'));
            if (clear)
                this.dirty = false;
            this.feedback.textContent = this.tr('Réglage appliqué.', 'Setting applied.');
            this.feedback.classList.remove('is-error');
            this.feedback.hidden = false;
        }
        catch (error) {
            if (!this.disposed) {
                this.feedback.textContent = error?.message || this.tr('Réessayez dans un instant.', 'Please try again shortly.');
                this.feedback.classList.add('is-error');
                this.feedback.hidden = false;
            }
        }
        finally {
            this.busy = false;
            if (!this.disposed)
                this.render();
        }
    }
    update(snapshot) { if (this.disposed)
        return; this.snapshot = snapshot?.telemetry || null; this.language = snapshot?.language === 'en' ? 'en' : 'fr'; this.render(); }
    render() {
        for (const [node, fr, en] of this.labels)
            node.textContent = this.tr(fr, en);
        const p = this.snapshot, connected = p?.connected === true, c = p?.capabilities || {};
        const status = { disabled: ['Mesures désactivées', 'Measurements disabled'], waiting: ['Connecteur non connecté', 'Connector not connected'], connecting: ['Connexion au jeu…', 'Connecting to game…'], connected: ['Mesures réelles connectées', 'Real measurements connected'], unsupported: ['Version du jeu non validée', 'Game version not validated'], stale: ['Mesures interrompues', 'Measurements interrupted'], error: ['Connexion aux mesures indisponible', 'Measurements unavailable'] }[p?.status || 'waiting'];
        this.status.textContent = this.tr(...status) + (p?.gameVersion ? ' · Clone Hero ' + p.gameVersion : '');
        this.status.dataset.connected = String(connected);
        this.enabled.checked = p?.enabled === true;
        this.enabled.disabled = this.busy || !p || p.canWrite === false;
        const timing = p?.timing || {};
        for (const [key, node] of Object.entries(this.metrics)) {
            const value = timing[key];
            node.textContent = this.format(value, key === 'sampleCount' ? 0 : 1) + (typeof value === 'number' ? (key === 'sampleCount' ? '' : key === 'withinWindowPercent' ? ' %' : ' ms') : '');
        }
        this.coverage.textContent = !connected ? this.tr('Les valeurs sont masquées quand la source est interrompue.', 'Values are hidden when the source is interrupted.') : this.tr('Décalage négatif : tôt. Positif : tard. ', 'Negative offset: early. Positive: late. ') + (timing.coverage === 'complete' ? this.tr('Mesures depuis le début de l’essai.', 'Measured from the start of the attempt.') : timing.coverage === 'since-connect' ? this.tr('Mesures depuis la connexion.', 'Measured since connection.') : this.tr('Mesures partielles après une interruption.', 'Partial measurements after an interruption.'));
        if (!this.dirty && p?.settings) {
            this.window.value = String(p.settings.windowMs);
            this.goal.value = p.settings.goal.kind;
            this.target.value = String(p.settings.goal.target);
            this.target.max = this.goal.value === 'minutes' ? '1440' : '10000';
        }
        for (const control of [this.window, this.goal, this.target, this.save])
            control.disabled = this.busy || !p || p.canWrite === false;
        this.add.disabled = this.busy || !p;
        this.reset.disabled = this.busy || !p;
        this.availability.replaceChildren();
        for (const [fr, en, ready] of [['Accuracy · six mesures', 'Accuracy · six metrics', c.hitTiming], ['Combo et record', 'Combo and record', c.combo], ['Progression du morceau', 'Song progress', c.clock], ['Ratées, surstrums et FC', 'Misses, overstrums and FC', c.misses && c.overstrums && c.attemptResults], ['Comparaison du record', 'Personal best comparison', c.score && c.songIdentity], ['Objectif et historique des morceaux', 'Song goal and attempt history', c.attemptResults]]) {
            const li = this.node('li', this.availability);
            li.textContent = this.tr(fr, en) + ' · ' + (connected && ready ? this.tr('disponible', 'available') : this.tr('en attente de données compatibles', 'waiting for compatible data'));
        }
        const trial = p?.calibration?.trial;
        for (const [stage, nodes] of Object.entries(this.nativeResults)) {
            const result = connected && c.calibrationResults && p?.calibration?.nativeResults?.[stage];
            const available = result && Number.isSafeInteger(result.settingMs) && result.settingMs >= -2000 && result.settingMs <= 2000 && Number.isSafeInteger(result.sampleCount) && result.sampleCount > 0 && result.source === 'native-calibration';
            nodes.value.textContent = available ? this.format(result.settingMs, 0) + ' ms' : '—';
            nodes.state.textContent = available ? this.tr('Valeur retenue par le jeu au dernier essai natif', 'Value retained by the game in the last native trial') + ' · ' + this.format(result.sampleCount, 0) + ' ' + this.tr('mesures reçues', 'received measurements') : !connected ? this.tr('Connectez le jeu pour recevoir ce résultat.', 'Connect the game to receive this result.') : !c.calibrationResults ? this.tr('Résultat natif indisponible avec ce connecteur.', 'Native result unavailable with this connector.') : this.tr(stage === 'audio' ? 'Terminez la calibration audio dans le jeu.' : 'Terminez la calibration vidéo dans le jeu.', stage === 'audio' ? 'Complete audio calibration in the game.' : 'Complete video calibration in the game.');
        }
        this.start.disabled = this.busy || !connected || !(this.source.value === 'tool' ? c.calibrationTiming : c.hitTiming);
        this.setting.disabled = this.busy;
        this.stage.disabled = this.busy;
        this.source.disabled = this.busy;
        this.finish.disabled = this.busy || !trial || trial.incomplete || trial.sampleCount < 30;
        this.trial.textContent = trial ? this.tr(trial.stage === 'audio' ? 'Essai audio' : 'Essai vidéo', trial.stage === 'audio' ? 'Audio trial' : 'Video trial') + ' · ' + this.format(trial.sampleCount, 0) + '/30 ' + this.tr('jugements', 'judgments') + (trial.incomplete ? ' · ' + this.tr('Interruption : redémarrez cet essai.', 'Interrupted: start this trial again.') : '') : this.tr('Aucun essai en cours.', 'No trial running.');
        this.trials.replaceChildren();
        for (const result of p?.calibration?.trials || []) {
            const li = this.node('li', this.trials);
            li.textContent = this.tr(result.stage === 'audio' ? 'Audio' : 'Vidéo', result.stage === 'audio' ? 'Audio' : 'Video') + ' ' + this.format(result.settingMs) + ' ms · ' + this.tr('moyenne', 'mean') + ' ' + this.format(result.meanOffsetMs) + ' ms · ' + this.tr('écart absolu', 'absolute offset') + ' ' + this.format(result.meanAbsoluteOffsetMs) + ' ms · ' + this.tr('dispersion', 'deviation') + ' ' + this.format(result.standardDeviationMs) + ' ms · ' + this.format(result.sampleCount, 0) + ' ' + this.tr('jugements', 'judgments');
        }
        if (p?.persistenceError && !this.busy) {
            this.feedback.textContent = p.persistenceError;
            this.feedback.classList.add('is-error');
            this.feedback.hidden = false;
        }
    }
    dispose() { this.disposed = true; for (const remove of this.listeners)
        remove(); }
}
