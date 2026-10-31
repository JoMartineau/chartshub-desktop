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
        this.calibrationDrafts = { audio: '', video: '' };
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
        this.text('p', 'Calibrez l’audio et la vidéo séparément. Chaque réglage garde sa saisie et ses essais. Vous pouvez commencer par celui de votre choix.', 'Calibrate audio and video separately. Each setting keeps its own input and trials. Start with either one.', details);
        this.text('p', 'L’analyse suit les jugements mesurés par le jeu. Elle ne mesure pas directement le délai physique des haut-parleurs ou de l’écran et ne garantit pas une calibration parfaite.', 'Analysis follows the judgments measured by the game. It does not directly measure physical speaker or display delay and cannot guarantee perfect calibration.', details);
        const step = (number, fr, en) => {
            const section = this.node('section', details, 'performance-calibration-step');
            section.dataset.calibrationStep = String(number);
            this.text('h3', number + '. ' + fr, number + '. ' + en, section);
            return section;
        };
        const chooseStage = step(1, 'Choisir le réglage', 'Choose the setting');
        const stage = this.node('label', chooseStage, 'performance-field');
        this.text('span', 'Réglage à calibrer', 'Setting to calibrate', stage);
        this.stage = this.node('select', stage);
        this.stage.id = 'calibration-stage';
        for (const [value, fr, en] of [['audio', 'Audio', 'Audio'], ['video', 'Vidéo', 'Video']]) {
            const option = this.text('option', fr, en, this.stage);
            option.value = value;
        }
        this.stageHint = this.node('p', chooseStage, 'helper-text');
        const chooseMethod = step(2, 'Choisir la méthode', 'Choose the method');
        const method = this.node('label', chooseMethod, 'performance-field');
        this.text('span', 'Méthode', 'Method', method);
        this.method = this.node('select', method);
        this.method.id = 'calibration-method';
        for (const [value, fr, en] of [['native', 'Automatique assistée · outil du jeu', 'Assisted automatic · game tool'], ['manual', 'Manuelle · essai avec l’outil du jeu', 'Manual · trial with the game tool'], ['gameplay', 'Analyse en jeu · passage d’une chart', 'In-game analysis · chart passage']]) {
            const option = this.text('option', fr, en, this.method);
            option.value = value;
        }
        this.methodHelp = this.node('p', chooseMethod, 'helper-text');
        const perform = step(3, 'Faire l’essai', 'Run the trial');
        this.instructions = this.node('ol', perform, 'performance-calibration-instructions');
        this.nativeProgress = this.node('p', perform, 'helper-text');
        this.nativeProgress.setAttribute('role', 'status');
        this.calibrationControls = this.node('div', perform);
        this.setting = field(this.calibrationControls, 'Valeur actuelle dans le jeu (ms)', 'Current in-game value (ms)');
        this.setting.id = 'calibration-setting';
        Object.assign(this.setting, { min: '-1000', max: '1000', step: 'any', required: true });
        this.text('p', 'Recopiez le réglage réellement présent dans Clone Hero. ChartsHub conserve cette saisie pour comparer vos essais ; il ne l’applique pas au jeu.', 'Enter the setting actually shown in Clone Hero. ChartsHub keeps this input to compare trials; it does not apply it to the game.', this.calibrationControls);
        const trialActions = this.node('div', this.calibrationControls, 'performance-actions');
        this.start = button(trialActions, 'Démarrer l’essai', 'Start trial', () => { if (this.setting.reportValidity())
            void this.run('telemetry.calibrationStart', { stage: this.stage.value, settingMs: Number(this.setting.value), source: this.calibrationSource() }); });
        this.start.id = 'calibration-start';
        this.finish = button(trialActions, 'Terminer et conserver l’essai', 'Finish and keep trial', () => void this.run('telemetry.calibrationFinish'));
        this.finish.id = 'calibration-finish';
        this.trial = this.node('p', perform, 'helper-text performance-calibration-trial');
        this.trial.setAttribute('role', 'status');
        this.liveTrial = this.node('p', perform, 'performance-calibration-live');
        this.replaceHint = this.text('p', 'Démarrer un nouvel essai remplace l’essai en cours. Un essai interrompu doit être recommencé.', 'Starting a new trial replaces the running one. Restart an interrupted trial.', this.calibrationControls);
        const read = step(4, 'Lire le résultat et comparer', 'Read the result and compare');
        this.nativePanel = this.node('div', read);
        const native = this.node('div', this.nativePanel, 'performance-calibration-results');
        this.nativeResults = {};
        for (const [key, fr, en] of [['audio', 'Délai audio', 'Audio delay'], ['video', 'Délai vidéo', 'Video delay']]) {
            const card = this.node('section', native, 'performance-calibration-result');
            card.dataset.stage = key;
            this.text('h3', fr, en, card);
            const value = this.node('p', card, 'performance-calibration-result-value');
            const state = this.node('p', card, 'helper-text');
            value.setAttribute('role', 'status');
            const copy = button(card, 'Reprendre dans ma saisie', 'Use in my input', () => {
                const result = this.nativeResult(key);
                if (!result) return;
                this.calibrationDrafts[key] = String(result.settingMs);
                if (this.stage.value === key) this.setting.value = this.calibrationDrafts[key];
                this.showFeedback('Valeur ' + (key === 'audio' ? 'audio' : 'vidéo') + ' reprise dans votre saisie locale. Aucun réglage du jeu n’a été changé.', (key === 'audio' ? 'Audio' : 'Video') + ' value copied to your local input. No game setting was changed.');
            });
            this.nativeResults[key] = { value, state, copy };
        }
        this.text('p', 'La valeur affichée a été retenue lors du dernier essai de l’outil de calibration du jeu, en millisecondes. C’est une valeur complète, pas un décalage à ajouter à votre réglage. Elle ne suit pas vos modifications manuelles ultérieures. ChartsHub ne modifie aucun réglage.', 'The displayed value was retained in the last trial of the game’s calibration tool, in milliseconds. It is an absolute value, not an offset to add to your setting. It does not track later manual changes. ChartsHub does not change any settings.', this.nativePanel);
        this.comparisonPanel = this.node('div', read);
        this.historyTitle = this.node('h4', this.comparisonPanel);
        this.text('p', 'Moyenne signée : négatif = tôt, positif = tard. L’écart absolu moyen indique la distance à zéro ; la dispersion indique la régularité. Ces mesures ne calculent pas un nouveau réglage audio ou vidéo.', 'Signed mean: negative = early, positive = late. Mean absolute offset is the distance from zero; deviation shows consistency. These measurements do not calculate a new audio or video setting.', this.comparisonPanel);
        this.trials = this.node('ol', this.comparisonPanel, 'performance-trials');
        this.emptyHistory = this.node('p', this.comparisonPanel, 'helper-text');
        this.regularity = this.node('p', this.comparisonPanel, 'helper-text');
        const comparable = this.node('label', this.comparisonPanel, 'performance-calibration-comparable');
        this.comparable = this.node('input', comparable);
        this.comparable.type = 'checkbox';
        this.comparable.id = 'calibration-comparable';
        this.text('span', 'Pour les deux derniers essais, j’ai gardé le même passage, la même vitesse et l’autre réglage inchangé.', 'For the two latest trials, I kept the same passage, the same speed and the other setting unchanged.', comparable);
        this.comparison = this.node('p', this.comparisonPanel, 'performance-calibration-comparison');
        this.listen(this.comparable, 'change', () => this.render());
        this.listen(this.setting, 'input', () => { this.calibrationDrafts[this.stage.value] = this.setting.value; });
        this.listen(this.stage, 'change', () => { this.setting.value = this.calibrationDrafts[this.stage.value]; this.comparable.checked = false; this.render(); });
        this.listen(this.method, 'change', () => { this.comparable.checked = false; this.render(); });
        button(details, 'Guide officiel Clone Hero', 'Official Clone Hero guide', () => void this.run('telemetry.guide'));
        this.feedback = this.node('p', root, 'performance-feedback');
        this.feedback.hidden = true;
        this.feedback.setAttribute('role', 'status');
        this.render();
    }
    tr(fr, en) { return this.language === 'en' ? en : fr; }
    showFeedback(fr, en) { this.feedbackMessage = [fr, en]; this.feedback.textContent = this.tr(fr, en); this.feedback.classList.remove('is-error'); this.feedback.hidden = false; }
    format(value, decimals = 1) { return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(this.language, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value) : '—'; }
    calibrationSource() { return this.method.value === 'gameplay' ? 'gameplay' : 'tool'; }
    nativeResult(stage) {
        const p = this.snapshot, result = p?.connected && p?.capabilities?.calibrationResults && p?.calibration?.nativeResults?.[stage];
        return result && Number.isSafeInteger(result.settingMs) && result.settingMs >= -2000 && result.settingMs <= 2000 && Number.isSafeInteger(result.sampleCount) && result.sampleCount > 0 && result.source === 'native-calibration' ? result : null;
    }
    signed(value) { return (value > 0 ? '+' : '') + this.format(value) + ' ms'; }
    trialMetrics(result) { return this.tr('moyenne signée', 'signed mean') + ' ' + this.signed(result.meanOffsetMs) + (result.meanOffsetMs < 0 ? this.tr(' (tôt)', ' (early)') : result.meanOffsetMs > 0 ? this.tr(' (tard)', ' (late)') : '') + ' · ' + this.tr('écart absolu', 'absolute offset') + ' ' + this.format(result.meanAbsoluteOffsetMs) + ' ms · ' + this.tr('dispersion', 'deviation') + ' ' + this.format(result.standardDeviationMs) + ' ms'; }
    async run(name, payload, clear = false) {
        if (this.busy || this.disposed)
            return;
        this.busy = true;
        this.feedbackMessage = null;
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
            this.showFeedback(...(name === 'telemetry.calibrationStart' ? ['Essai démarré. Aucun réglage du jeu n’a été changé.', 'Trial started. No game setting was changed.'] : name === 'telemetry.calibrationFinish' ? ['Essai conservé dans l’historique de ce réglage et de cette méthode.', 'Trial kept in the history for this setting and method.'] : ['Action terminée.', 'Action completed.']));
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
        if (this.feedbackMessage) this.feedback.textContent = this.tr(...this.feedbackMessage);
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
            const result = this.nativeResult(stage);
            nodes.value.textContent = result ? this.format(result.settingMs, 0) + ' ms' : '—';
            nodes.state.textContent = result ? this.tr('Valeur retenue par le jeu au dernier essai natif', 'Value retained by the game in the last native trial') + ' · ' + this.format(result.sampleCount, 0) + ' ' + this.tr('mesures reçues', 'received measurements') : !connected ? this.tr('Connectez le jeu pour recevoir ce résultat.', 'Connect the game to receive this result.') : !c.calibrationResults ? this.tr('Résultat natif indisponible avec ce connecteur.', 'Native result unavailable with this connector.') : this.tr(stage === 'audio' ? 'Terminez la calibration audio dans le jeu.' : 'Terminez la calibration vidéo dans le jeu.', stage === 'audio' ? 'Complete audio calibration in the game.' : 'Complete video calibration in the game.');
            nodes.copy.disabled = this.busy || !result || result.settingMs < -1000 || result.settingMs > 1000;
        }
        const audio = this.stage.value === 'audio', native = this.method.value === 'native', gameplay = this.method.value === 'gameplay', source = this.calibrationSource();
        this.stageHint.textContent = audio ? this.tr('Audio : comparez les notes à la musique. Si les notes arrivent avant le son, augmentez le délai audio dans le jeu ; si elles arrivent après, diminuez-le.', 'Audio: compare notes with the music. If notes arrive before the sound, increase the audio delay in the game; if they arrive after, decrease it.') : this.tr('Vidéo : activez « Show Hit Window » dans Clone Hero et vérifiez les frappes au centre de la fenêtre. Testez ce réglage indépendamment de l’audio.', 'Video: enable “Show Hit Window” in Clone Hero and check hits at the center of the window. Test this setting independently of audio.');
        this.methodHelp.textContent = native ? this.tr('Le jeu réalise sa calibration ; ChartsHub reçoit automatiquement les valeurs retenues. L’outil natif peut modifier les deux délais. Votre choix Audio/Vidéo ici sépare uniquement les saisies et essais ChartsHub.', 'The game runs its calibration; ChartsHub automatically receives the retained values. The native tool may change both delays. Your Audio/Video choice here only separates ChartsHub inputs and trials.') : gameplay ? this.tr('Mesurez vos frappes pendant une chart pour vérifier un réglage, puis comparez avant et après un changement manuel dans le jeu.', 'Measure your hits during a chart to check a setting, then compare before and after a manual change in the game.') : this.tr('Notez votre réglage et mesurez un essai avec l’outil du jeu. Cet outil peut modifier les deux délais : vérifiez-les ensuite dans Clone Hero. Les mesures natives restent séparées des frappes en jeu.', 'Record your setting and measure a trial with the game tool. This tool may change both delays: check them afterward in Clone Hero. Native measurements remain separate from chart hits.');
        const settingName = this.tr(audio ? 'audio' : 'vidéo', audio ? 'audio' : 'video');
        const instructions = native ? [
            this.tr('Dans Clone Hero : Réglages → Gameplay → Calibration.', 'In Clone Hero: Settings → Gameplay → Calibration.'),
            this.tr('Lancez l’outil natif et suivez ses indications jusqu’au résultat. Vérifiez les deux délais qu’il a retenus dans le jeu.', 'Start the native tool and follow its instructions through to the result. Check both delays it retained in the game.'),
            this.tr('Revenez à l’étape 4 : le résultat ' + settingName + ' reçu apparaît automatiquement. Vous pourrez le reprendre dans votre saisie locale.', 'Return to step 4: the received ' + settingName + ' result appears automatically. You can reuse it in your local input.')
        ] : gameplay ? [
            this.tr('Utilisez une chart de calibration connue, avec le même passage et la même vitesse à chaque essai. Notez le réglage ' + settingName + ' actuel et gardez l’autre réglage inchangé.', 'Use a known calibration chart, with the same passage and speed for every trial. Note the current ' + settingName + ' setting and leave the other setting unchanged.'),
            this.tr('Une fois le passage lancé, recopiez la valeur ci-dessous et démarrez l’essai ChartsHub avant les frappes à mesurer.', 'Once the passage is running, enter the value below and start the ChartsHub trial before the hits you want to measure.'),
            this.tr('Jouez au moins 30 frappes continues, sans redémarrer ni déplacer la lecture, puis terminez l’essai. Pour comparer, changez seulement le réglage ' + settingName + ' dans le jeu et rejouez le même passage à la même vitesse.', 'Play at least 30 continuous hits without restarting or seeking, then finish the trial. To compare, change only the ' + settingName + ' setting in the game and replay the same passage at the same speed.')
        ] : [
            this.tr('Dans Clone Hero, relevez le réglage ' + settingName + ' actuel. Recopiez-le ci-dessous et démarrez l’essai ChartsHub.', 'In Clone Hero, read the current ' + settingName + ' setting. Enter it below and start the ChartsHub trial.'),
            this.tr('Ouvrez Réglages → Gameplay → Calibration, puis utilisez l’outil natif. Seules les mesures ' + settingName + ' reçues de cet outil sont comptées.', 'Open Settings → Gameplay → Calibration, then use the native tool. Only ' + settingName + ' measurements received from that tool are counted.'),
            this.tr('Après au moins 30 mesures continues du même essai natif, terminez ici pour conserver les mesures. Un nouvel essai ou un changement audio/vidéo impose de recommencer le compteur.', 'After at least 30 continuous measurements from the same native trial, finish here to keep the measurements. A new native trial or an audio/video change requires a fresh counter.')
        ];
        this.instructions.replaceChildren();
        for (const instruction of instructions) this.node('li', this.instructions).textContent = instruction;
        this.nativePanel.hidden = !native;
        this.comparisonPanel.hidden = native;
        this.calibrationControls.hidden = native;
        this.nativeProgress.hidden = !native;
        this.nativeProgress.textContent = this.nativeResults[this.stage.value].state.textContent;
        this.start.disabled = this.busy || native || !connected || !(gameplay ? c.hitTiming : c.calibrationTiming);
        this.setting.disabled = this.busy;
        this.stage.disabled = this.busy;
        this.method.disabled = this.busy;
        const matchingTrial = !native && trial?.stage === this.stage.value && trial?.source === source;
        this.finish.disabled = this.busy || !connected || !matchingTrial || trial.incomplete || trial.sampleCount < 30;
        this.replaceHint.hidden = !trial;
        this.trial.hidden = native && !trial;
        this.trial.textContent = trial ? this.tr(trial.stage === 'audio' ? 'Essai audio' : 'Essai vidéo', trial.stage === 'audio' ? 'Audio trial' : 'Video trial') + ' · ' + this.tr(trial.source === 'gameplay' ? 'frappes en jeu' : 'outil du jeu', trial.source === 'gameplay' ? 'chart hits' : 'game tool') + ' · ' + this.format(trial.settingMs) + ' ms · ' + this.format(trial.sampleCount, 0) + '/30 ' + this.tr('mesures', 'measurements') + (!connected || trial.incomplete ? ' · ' + this.tr('Interruption : recommencez cet essai.', 'Interrupted: restart this trial.') : !matchingTrial ? ' · ' + this.tr('Choisissez ce réglage et cette méthode pour terminer cet essai.', 'Choose this setting and method to finish this trial.') : '') : !connected ? this.tr('Connectez les mesures réelles pour démarrer un essai.', 'Connect real measurements to start a trial.') : !(gameplay ? c.hitTiming : c.calibrationTiming) ? this.tr('Cette méthode nécessite des mesures compatibles avec le connecteur.', 'This method requires compatible connector measurements.') : this.tr('Aucun essai en cours. Terminer devient disponible à partir de 30 mesures continues.', 'No trial running. Finish becomes available after 30 continuous measurements.');
        this.liveTrial.hidden = !connected || !matchingTrial || trial?.incomplete || !trial?.sampleCount;
        this.liveTrial.textContent = this.liveTrial.hidden ? '' : this.trialMetrics(trial);
        this.historyTitle.textContent = this.tr('Historique ' + settingName + ' · ' + (gameplay ? 'analyse en jeu' : 'outil du jeu'), (audio ? 'Audio' : 'Video') + ' history · ' + (gameplay ? 'in-game analysis' : 'game tool'));
        const results = (p?.calibration?.trials || []).filter(result => result.stage === this.stage.value && result.source === source);
        this.trials.replaceChildren();
        for (const result of results) {
            const li = this.node('li', this.trials);
            li.textContent = this.tr('Réglage saisi', 'Entered setting') + ' ' + this.format(result.settingMs) + ' ms · ' + this.trialMetrics(result) + ' · ' + this.format(result.sampleCount, 0) + ' ' + this.tr('mesures', 'measurements');
        }
        const comparisonIdentity = JSON.stringify([this.stage.value, source, results.slice(0, 2)]);
        if (this.comparisonIdentity !== comparisonIdentity) { this.comparable.checked = false; this.comparisonIdentity = comparisonIdentity; }
        this.emptyHistory.hidden = results.length > 0;
        this.emptyHistory.textContent = this.tr('Aucun essai conservé pour ce réglage et cette méthode.', 'No trials kept for this setting and method.');
        const regularity = connected && matchingTrial && !trial.incomplete && trial.sampleCount >= 30 ? trial : results[0];
        this.regularity.hidden = !regularity || regularity.sampleCount < 30 || !Number.isFinite(regularity.standardDeviationMs);
        this.regularity.textContent = this.regularity.hidden ? '' : this.tr('Régularité de l’essai', 'Trial consistency') + ' · ' + this.tr('dispersion', 'deviation') + ' ' + this.format(regularity.standardDeviationMs) + ' ms. ' + this.tr('Une faible dispersion indique des frappes plus régulières. Refaites plusieurs essais dans les mêmes conditions pour vérifier que les moyennes restent proches.', 'Lower deviation means more consistent hits. Repeat trials under the same conditions to check that the means remain close.');
        this.comparable.disabled = results.length < 2;
        this.comparison.textContent = results.length < 2 ? this.tr('Conservez deux essais de ce réglage avec cette méthode pour comparer avant et après.', 'Keep two trials for this setting and method to compare before and after.') : !this.comparable.checked ? this.tr('Vérifiez les conditions identiques ci-dessus pour comparer les deux derniers essais.', 'Confirm the matching conditions above to compare the two latest trials.') : this.tr('Avant', 'Before') + ' · ' + this.format(results[1].settingMs) + ' ms · ' + this.trialMetrics(results[1]) + '\n' + this.tr('Après', 'After') + ' · ' + this.format(results[0].settingMs) + ' ms · ' + this.trialMetrics(results[0]) + '\n' + this.tr('Variation de l’écart absolu moyen', 'Change in mean absolute offset') + ' : ' + this.signed(results[0].meanAbsoluteOffsetMs - results[1].meanAbsoluteOffsetMs) + '. ' + this.tr('Une baisse rapproche les frappes de zéro, sans déterminer à elle seule le bon réglage.', 'A decrease brings hits closer to zero, without determining the right setting on its own.');
        if (p?.persistenceError && !this.busy) {
            this.feedbackMessage = null;
            this.feedback.textContent = p.persistenceError;
            this.feedback.classList.add('is-error');
            this.feedback.hidden = false;
        }
    }
    dispose() { this.disposed = true; for (const remove of this.listeners)
        remove(); }
}
