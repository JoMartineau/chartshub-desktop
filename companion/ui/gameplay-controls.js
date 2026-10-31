/** Measurements come from the local connector, never from a percentage or a screenshot. */
class ConnectorSetupControls {
    constructor(owner, parent) {
        this.owner = owner;
        const calibrationBeta = owner.calibrationBeta === true;
        const node = (tag, container = parent, css = '') => owner.node(tag, container, css);
        const text = (tag, fr, en, container = parent) => owner.text(tag, fr, en, container);
        this.root = node('details', parent, 'performance-connector-setup');
        text('summary', 'Installer le connecteur · étapes de démarrage', 'Install the connector · getting started', this.root);
        text('p', ...(calibrationBeta ? ['Le connecteur fournit les frappes réelles. L’installation est facultative ; la calibration dans le jeu reste possible sans lui.', 'The connector provides real hit measurements. Installation is optional; in-game calibration remains available without it.'] : ['Le connecteur fournit les mesures réelles pour Accuracy, le combo et les widgets. Son installation est facultative et demande votre confirmation.', 'The connector supplies real measurements for Accuracy, combo and widgets. Installation is optional and requires your confirmation.']), this.root);
        this.steps = node('ol', this.root, 'performance-connector-steps');
        for (const [fr, en] of [
            ['Choisir le dossier du jeu et vérifier sa version.', 'Choose the game folder and check its version.'],
            calibrationBeta ? ['Vérifier la compatibilité. Une version non reconnue utilise le guide manuel ci-dessous.', 'Check compatibility. An unrecognized version uses the manual guide below.'] : ['Vérifier la compatibilité. Les limites des versions non reconnues sont expliquées ci-dessous.', 'Check compatibility. Limitations for unrecognized versions are explained below.'],
            ['Fermer Clone Hero et son lanceur, puis confirmer l’ajout de MelonLoader et du connecteur.', 'Close Clone Hero and its launcher, then confirm adding MelonLoader and the connector.'],
            ['Lancer le jeu vous-même, activer « Recevoir les mesures » et jouer quelques notes pour vérifier la connexion.', 'Start the game yourself, enable “Receive measurements” and play a few notes to verify the connection.'],
            ...(calibrationBeta ? [
                ['Calibrer l’audio avec votre chart connue, en gardant le délai vidéo inchangé.', 'Calibrate audio with your known chart, keeping video delay unchanged.'],
                ['Calibrer la vidéo séparément, en gardant le délai audio obtenu, la même chart et le même matériel.', 'Calibrate video separately, keeping the resulting audio delay, the same chart and hardware.']
            ] : [])
        ]) text('li', fr, en, this.steps);
        this.status = node('p', this.root, 'performance-connector-status'); this.status.id = 'connector-setup-status'; this.status.setAttribute('role', 'status');
        this.compatibility = node('p', this.root, 'helper-text');
        this.destination = node('p', this.root, 'helper-text performance-connector-destination'); this.destination.id = 'connector-setup-destination'; this.destination.hidden = true;
        this.scope = node('p', this.root, 'helper-text performance-connector-scope'); this.scope.id = 'connector-setup-scope'; this.scope.hidden = true;
        this.problem = node('p', this.root, 'performance-connector-problem'); this.problem.hidden = true;
        const buttons = node('div', this.root, 'performance-actions');
        const button = (id, fr, en, action) => { const b = text('button', fr, en, buttons); b.type = 'button'; b.className = 'button secondary'; b.id = id; owner.listen(b, 'click', action); return b; };
        this.choose = button('connector-setup-choose', 'Choisir le dossier du jeu', 'Choose game folder', () => void owner.run('telemetry.connectorChoose'));
        this.prepare = button('connector-setup-prepare', 'Vérifier la compatibilité', 'Check compatibility', () => void owner.run('telemetry.connectorPrepare', { hideConsole: this.hideConsole.checked }));
        this.cancel = button('connector-setup-cancel', 'Annuler cette préparation', 'Cancel this preparation', () => void owner.run('telemetry.connectorCancel'));
        const hidden = node('label', this.root, 'performance-calibration-comparable');
        this.hideConsole = node('input', hidden); this.hideConsole.type = 'checkbox'; this.hideConsole.checked = true; this.hideConsole.id = 'connector-setup-hide-console';
        text('span', 'Masquer la console MelonLoader lors de la nouvelle installation', 'Hide the MelonLoader console for a new installation', hidden);
        owner.listen(this.hideConsole, 'change', () => { this.changedPlan = true; this.consent.checked = false; this.render(); });
        const consent = node('label', this.root, 'performance-calibration-comparable');
        this.consent = node('input', consent); this.consent.type = 'checkbox'; this.consent.id = 'connector-setup-consent';
        this.consentText = node('span', consent);
        owner.listen(this.consent, 'change', () => this.render());
        const operations = node('div', this.root, 'performance-actions');
        this.install = text('button', 'Installer le connecteur', 'Install the connector', operations); this.install.id = 'connector-setup-install'; this.install.type = 'button'; this.install.className = 'button';
        owner.listen(this.install, 'click', () => void owner.run('telemetry.connectorInstall', { planId: owner.snapshot?.connectorSetup?.planId, confirmation: true }));
        this.remove = text('button', 'Retirer cette installation', 'Remove this installation', operations); this.remove.id = 'connector-setup-remove'; this.remove.type = 'button'; this.remove.className = 'button secondary';
        owner.listen(this.remove, 'click', () => void owner.run('telemetry.connectorRollback', { receiptId: owner.snapshot?.connectorSetup?.receiptId, confirmation: true }));
        this.connection = node('p', this.root, 'helper-text');
        text('p', 'Aucun jeu n’est lancé automatiquement. Au premier lancement, MelonLoader peut préparer ses composants et télécharger ses propres dépendances. ChartsHub conserve les fichiers déjà présents ; une installation en conflit demande une vérification manuelle.', 'No game is started automatically. At first launch, MelonLoader may prepare components and download its own dependencies. ChartsHub preserves existing files; a conflicting installation requires manual review.', this.root);
        const manual = node('details', this.root, 'performance-connector-manual');
        text('summary', ...(calibrationBeta ? ['Continuer sans connecteur · calibration manuelle', 'Continue without a connector · manual calibration'] : ['Versions non reconnues · possibilités et limites', 'Unrecognized versions · possibilities and limitations']), manual);
        const guide = node('ol', manual, 'performance-connector-steps');
        for (const [fr, en] of calibrationBeta ? [
            ['Dans les réglages de votre version de Clone Hero, repérez la calibration audio/vidéo. Notez les deux valeurs actuelles avant un changement.', 'In your Clone Hero version’s settings, locate audio/video calibration. Write down both current values before changing anything.'],
            ['Audio : suivez l’outil natif du jeu ou votre chart de calibration connue. Ajustez uniquement le délai audio et gardez le délai vidéo inchangé.', 'Audio: follow the game’s native tool or your known calibration chart. Adjust only audio delay and leave video delay unchanged.'],
            ['Vidéo : testez séparément l’alignement visuel avec la fenêtre de frappe si votre version la propose. Gardez le réglage audio, le même écran et la même fréquence.', 'Video: separately test visual alignment using the hit window if your version provides it. Keep audio, display and refresh rate unchanged.'],
            ['Rejouez le même passage à la même vitesse. Si l’outil natif a modifié les deux délais, vérifiez-les de nouveau. Sans connecteur compatible, ChartsHub ne reçoit ni frappes ni résultats automatiques.', 'Replay the same passage at the same speed. If the native tool changed both delays, check them again. Without a compatible connector, ChartsHub receives neither hits nor automatic results.']
        ] : [
            ['L’installation automatique est proposée uniquement pour la version du jeu vérifiée ci-dessus. Une version non reconnue ne reçoit aucun ajout.', 'Automatic installation is offered only for the verified game build shown above. An unrecognized version receives no additions.'],
            ['Vous pouvez continuer à utiliser les fonctions de ChartsHub indépendantes de ces mesures. Les widgets qui les nécessitent restent en attente d’une source compatible.', 'You can continue using ChartsHub features that do not depend on these measurements. Widgets that require them wait for a compatible source.']
        ]) text('li', fr, en, guide);
    }
    render() {
        const o = this.owner, tr = (fr, en) => o.tr(fr, en), s = o.snapshot?.connectorSetup;
        const identity = JSON.stringify([s?.status, s?.planId, s?.receiptId]);
        if (identity !== this.identity) { this.identity = identity; this.consent.checked = false; if (s?.status === 'ready') this.changedPlan = false; }
        const statuses = { idle: ['Choisissez le dossier du jeu pour commencer.', 'Choose the game folder to begin.'], selected: ['Dossier choisi. Vérifiez sa compatibilité.', 'Folder selected. Check compatibility.'], unsupported: ['Cette version n’est pas validée. Utilisez la calibration manuelle ci-dessous.', 'This version is not validated. Use manual calibration below.'], ready: ['Compatible : installation prête à confirmer.', 'Compatible: installation ready for confirmation.'], installed: ['Le connecteur est présent. Vérifiez ensuite la connexion dans le jeu.', 'The connector is present. Next verify the live game connection.'], conflict: ['Fichiers existants incompatibles : aucune modification. Vérifiez votre installation.', 'Existing files conflict: no changes made. Review your installation.'], busy: ['Vérification ou installation en cours…', 'Checking or installing…'], error: ['Cette opération ne peut pas être terminée. Vérifiez le dossier, les droits et que le jeu et son lanceur sont fermés.', 'This operation could not finish. Check the folder, permissions, and that the game and launcher are closed.'] };
        if (!o.calibrationBeta) statuses.unsupported = ['Cette version ne possède pas encore de connecteur validé. Consultez les possibilités et limites ci-dessous.', 'This version does not yet have a validated connector. See the possibilities and limitations below.'];
        this.status.textContent = tr(...(statuses[s?.busy ? 'busy' : s?.status] || statuses.idle)) + (s?.gameLabel ? ' · ' + s.gameLabel : '') + (s?.version ? ' · ' + s.version : '');
        this.compatibility.textContent = tr('Installation automatique : Windows x64, Clone Hero 1.1.0.6142 IL2CPP vérifié. MelonLoader 0.7.3 et connecteur 0.2.2. ', 'Automatic setup: verified Windows x64 Clone Hero 1.1.0.6142 IL2CPP. MelonLoader 0.7.3 and connector 0.2.2. ') + (o.calibrationBeta ? tr('Les autres versions restent en mode manuel tant qu’elles ne sont pas validées.', 'Other versions remain manual until validated.') : tr('Les mesures de frappe des autres versions ne sont pas encore prises en charge.', 'Hit measurements from other versions are not yet supported.'));
        const destination = typeof s?.destination === 'string' && s.destination.length > 0 && s.destination.length <= 240 && !/[\x00-\x1f\x7f]/.test(s.destination) ? s.destination : null;
        this.destination.hidden = !destination; this.destination.textContent = destination ? tr('Installation choisie : ', 'Selected installation: ') + destination : '';
        this.scope.hidden = s?.status !== 'ready'; this.scope.textContent = tr('Ajouts prévus : ', 'Planned additions: ') + 'version.dll · MelonLoader/ · Mods/ChartsHub.CloneHero.Telemetry.dll · UserData/Loader.cfg';
        const reasons = {
            GAME_REQUIRED: ['Choisissez d’abord le dossier qui contient le jeu.', 'First choose the folder containing the game.'],
            GAME_INVALID: ['Le dossier choisi ne contient pas les fichiers attendus du jeu. Choisissez le dossier de Clone Hero.exe.', 'The chosen folder does not contain the expected game files. Choose the Clone Hero.exe folder.'],
            GAME_UNSUPPORTED: ['Cette version ne possède pas encore de connecteur validé. Le guide manuel reste disponible.', 'This version does not yet have a validated connector. The manual guide remains available.'],
            PLATFORM_UNSUPPORTED: ['L’installation de ce connecteur est proposée sous Windows x64. Utilisez le guide manuel sur cet appareil.', 'This connector installer is available on Windows x64. Use the manual guide on this device.'],
            GAME_RUNNING: ['Fermez Clone Hero et son lanceur, puis vérifiez de nouveau. Aucun fichier du jeu n’a été ajouté.', 'Close Clone Hero and its launcher, then check again. No game file was added.'],
            PROCESS_UNKNOWN: ['ChartsHub ne peut pas vérifier que le jeu et son lanceur sont fermés. L’installation reste bloquée.', 'ChartsHub cannot verify that the game and launcher are closed. Installation remains blocked.'],
            CONFLICT: ['Un chargeur, un mod ou un fichier de configuration déjà présent serait en conflit. Il est conservé. Vérifiez-le avant une nouvelle préparation.', 'An existing loader, mod or configuration file conflicts. It is preserved. Review it before preparing again.'],
            PAYLOAD_INVALID: ['Les fichiers du connecteur n’ont pas passé la vérification. N’installez pas de fichier de remplacement non vérifié.', 'Connector files did not pass verification. Do not install an unverified replacement.'],
            DOWNLOAD_FAILED: ['La préparation des composants a échoué. Aucun lancement automatique du jeu ne sera tenté.', 'Component preparation failed. No automatic game launch will be attempted.'],
            PREPARE_REQUIRED: ['Vérifiez la compatibilité avant de confirmer l’installation.', 'Check compatibility before confirming installation.'],
            CONSENT_REQUIRED: ['Cochez la confirmation de cette opération avant de continuer.', 'Check the confirmation for this operation before continuing.'],
            PLAN_CHANGED: ['La préparation a changé. Vérifiez à nouveau la compatibilité, puis confirmez le nouveau résultat.', 'Preparation changed. Check compatibility again, then confirm the new result.'],
            RECEIPT_INVALID: ['Le reçu de cette installation ne peut pas être vérifié. Le retrait automatique reste bloqué.', 'This installation receipt cannot be verified. Automatic removal remains blocked.'],
            ROLLBACK_CHANGED: ['Des fichiers ont changé depuis leur installation. ChartsHub les conserve ; vérifiez-les manuellement avant de retirer le connecteur.', 'Files changed after installation. ChartsHub preserves them; review them manually before removing the connector.'],
            RECOVERY_REQUIRED: ['Installation interrompue. Fermez le jeu et son lanceur, puis confirmez le retrait des fichiers inchangés de cette installation avant de recommencer. Les fichiers modifiés seront conservés.', 'Installation was interrupted. Close the game and launcher, then confirm removal of this installation’s unchanged files before starting again. Modified files will be preserved.'],
            INSTALL_FAILED: ['L’installation s’est arrêtée. Vérifiez son état avant de relancer une préparation ; le jeu ne sera pas lancé.', 'Installation stopped. Check its state before preparing again; the game will not be started.'],
            BUSY: ['Attendez la fin de l’opération en cours.', 'Wait for the current operation to finish.']
        };
        this.problem.hidden = !reasons[s?.errorCode]; this.problem.textContent = reasons[s?.errorCode] ? tr(...reasons[s.errorCode]) : '';
        if (s?.status === 'ready' && Number.isSafeInteger(s.files) && s.files > 0) this.status.textContent += tr(' · ', ' · ') + s.files + tr(' fichiers à ajouter · console ', ' files to add · console ') + (this.hideConsole.checked ? tr('masquée', 'hidden') : tr('visible', 'visible'));
        const busy = o.busy || s?.busy === true || s?.status === 'busy', canRemove = (s?.status === 'installed' || s?.recoveryRequired === true) && typeof s.receiptId === 'string';
        this.choose.disabled = busy || !s;
        this.prepare.disabled = busy || !s || s.status === 'idle';
        this.cancel.hidden = s?.status !== 'ready'; this.cancel.disabled = busy;
        this.hideConsole.disabled = busy || s?.status === 'installed' || s?.recoveryRequired === true;
        if (s?.status === 'installed' && typeof s.hideConsole === 'boolean') this.hideConsole.checked = s.hideConsole;
        this.consent.disabled = busy || (!canRemove && s?.status !== 'ready') || this.changedPlan;
        this.consentText.textContent = canRemove ? tr('Je confirme le retrait des seuls fichiers installés par ChartsHub et restés inchangés.', 'I confirm removal only of files installed by ChartsHub that remain unchanged.') : tr('J’autorise les ajouts prévus dans l’installation choisie ci-dessus. Mes chansons et réglages de jeu sont conservés.', 'I authorize the planned additions to the selected installation above. My songs and game settings are preserved.');
        this.install.hidden = s?.status === 'installed'; this.install.disabled = busy || s?.status !== 'ready' || this.changedPlan || !this.consent.checked;
        this.remove.hidden = !canRemove; this.remove.disabled = busy || !canRemove || !this.consent.checked;
        if (s?.recoveryRequired === true) this.remove.textContent = tr('Retirer les fichiers de l’installation interrompue', 'Remove interrupted installation files');
        this.connection.textContent = o.snapshot?.connected ? tr('Connexion vérifiée : des mesures compatibles sont reçues du jeu.', 'Connection verified: compatible measurements are being received from the game.') : s?.status === 'installed' ? tr('Étape suivante : lancez Clone Hero vous-même, activez la réception et jouez quelques notes. La présence des fichiers seule ne confirme pas la connexion.', 'Next: start Clone Hero yourself, enable receiving and play a few notes. File presence alone does not confirm a connection.') : this.changedPlan && s?.status === 'ready' ? tr('L’option console a changé : vérifiez à nouveau la compatibilité avant de confirmer.', 'The console option changed: check compatibility again before confirming.') : '';
    }
}
export class GameplayControls {
    constructor({ root, calibrationRoot = root, gameplayMeasurements = false, calibrationBeta = false, command }) {
        this.root = root;
        this.gameplayMeasurements = gameplayMeasurements === true;
        this.calibrationBeta = this.gameplayMeasurements && calibrationBeta === true;
        this.command = command;
        this.language = 'fr';
        this.snapshot = null;
        this.busy = false;
        this.dirty = false;
        this.disposed = false;
        this.labels = [];
        this.listeners = [];
        this.calibrationDrafts = { audio: '', video: '' };
        if (!this.gameplayMeasurements) return;
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
        const dedicatedCalibration = this.calibrationBeta && calibrationRoot && calibrationRoot !== root;
        if (this.calibrationBeta) {
        if (dedicatedCalibration) {
            const heading = this.node('div', calibrationRoot, 'card-heading calibration-heading'), title = this.node('div', heading);
            const h2 = this.text('h2', 'Calibration audio et vidéo', 'Audio and video calibration', title); h2.id = 'calibration-title';
            const beta = this.node('span', heading, 'calibration-beta-badge'); beta.textContent = 'BETA';
            this.text('p', 'Fonction en cours d’essai : suivez les étapes, vérifiez les résultats et conservez vos réglages précédents. La précision dépend du jeu, du matériel et de vos frappes.', 'Experimental feature: follow the steps, verify results and keep your previous settings. Precision depends on the game, hardware and your hits.', calibrationRoot);
            const receive = this.node('label', calibrationRoot, 'performance-enable calibration-enable');
            this.calibrationEnabled = this.node('input', receive); this.calibrationEnabled.type = 'checkbox'; this.calibrationEnabled.id = 'calibration-receive-measurements';
            this.text('span', 'Recevoir les mesures pour la calibration', 'Receive calibration measurements', receive);
            this.listen(this.calibrationEnabled, 'change', () => void this.run('telemetry.enabled', { enabled: this.calibrationEnabled.checked }));
            this.calibrationStatus = this.node('p', calibrationRoot, 'performance-status calibration-status'); this.calibrationStatus.setAttribute('role', 'status');
        }
        const details = this.node('details', calibrationRoot || root, 'performance-calibration');
        details.open = dedicatedCalibration;
        this.text('summary', 'Aide à la calibration audio et vidéo', 'Audio and video calibration helper', details);
        this.text('p', 'Calibrez l’audio et la vidéo séparément. Chaque réglage garde sa saisie et ses essais. Vous pouvez commencer par celui de votre choix.', 'Calibrate audio and video separately. Each setting keeps its own input and trials. Start with either one.', details);
        this.text('p', 'L’analyse suit les jugements mesurés par le jeu. Elle ne mesure pas directement le délai physique des haut-parleurs ou de l’écran et ne garantit pas une calibration parfaite.', 'Analysis follows the judgments measured by the game. It does not directly measure physical speaker or display delay and cannot guarantee perfect calibration.', details);
        this.connectorSetup = new ConnectorSetupControls(this, details);
        const hardware = this.node('details', details, 'performance-calibration-hardware');
        this.text('summary', 'Reconnaître le matériel et adapter les essais', 'Recognize hardware and adapt trials', hardware);
        this.text('p', 'La détection lit les noms du matériel et les modes déclarés par le système, uniquement à votre demande. Aucun son, enregistrement ou capture d’écran. Retard physique non mesuré.', 'Detection reads hardware names and modes reported by the system, only on request. No sound, recording or screen capture. Physical delay is not measured.', hardware);
        this.hardwareRefresh = button(hardware, 'Détecter / actualiser le matériel', 'Detect / refresh hardware', () => void this.refreshHardware());
        this.hardwareRefresh.id = 'calibration-hardware-detect';
        this.hardwareStatus = this.node('p', hardware, 'helper-text');
        this.hardwareStatus.setAttribute('role', 'status');
        this.hardwareAudio = this.node('p', hardware, 'helper-text');
        this.hardwareVideo = this.node('p', hardware, 'helper-text');
        this.hardwareInputs = this.node('p', hardware, 'helper-text');
        const hardwareChoice = (fr, en, id) => {
            const label = this.node('label', hardware, 'performance-field');
            this.text('span', fr, en, label);
            const select = this.node('select', label); select.id = id;
            return select;
        };
        const hardwareField = (fr, en, id) => {
            const label = this.node('label', hardware, 'performance-field');
            this.text('span', fr, en, label);
            const input = this.node('input', label); input.type = 'text'; input.maxLength = 120; input.id = id;
            return input;
        };
        this.hardwareOutputChoice = hardwareChoice('Choisir une sortie audio détectée', 'Choose a detected audio output', 'calibration-hardware-output-choice');
        this.hardwareOutput = hardwareField('Sortie audio réellement utilisée · saisie libre', 'Audio output actually used · manual entry', 'calibration-hardware-output');
        this.hardwareInputChoice = hardwareChoice('Choisir une guitare / un clavier détecté', 'Choose a detected guitar / keyboard', 'calibration-hardware-input-choice');
        this.hardwareInput = hardwareField('Guitare / clavier réellement utilisé · saisie libre', 'Guitar / keyboard actually used · manual entry', 'calibration-hardware-input');
        this.hardwareInputList = this.node('datalist', hardware); this.hardwareInputList.id = 'calibration-hardware-inputs';
        this.hardwareInput.setAttribute('list', this.hardwareInputList.id);
        const displayLabel = this.node('label', hardware, 'performance-field');
        this.text('span', 'Écran utilisé par le jeu · à choisir', 'Display used by the game · select it', displayLabel);
        this.hardwareDisplay = this.node('select', displayLabel); this.hardwareDisplay.id = 'calibration-hardware-display';
        this.hardwareNote = hardwareField('Connexion et mode écran (ex. USB, Bluetooth, mode Jeu TV)', 'Connection and display mode (e.g. USB, Bluetooth, TV Game mode)', 'calibration-hardware-note');
        const confirmed = this.node('label', hardware, 'performance-calibration-comparable');
        this.hardwareConfirmed = this.node('input', confirmed); this.hardwareConfirmed.type = 'checkbox'; this.hardwareConfirmed.id = 'calibration-hardware-confirmed';
        this.text('span', 'J’ai vérifié ces choix dans le jeu. Joindre cette configuration aux prochains essais.', 'I checked these choices in the game. Attach this setup to future trials.', confirmed);
        this.text('p', 'Le défaut Windows ne prouve pas la sortie utilisée par Clone Hero. Les entrées proposées sont des candidates. Les informations restent locales à cette session ; vous pouvez continuer sans détection.', 'The Windows default does not prove which output Clone Hero uses. Suggested inputs are candidates. Information stays local to this session; trials remain available without detection.', hardware);
        this.text('p', 'Détectez les appareils disponibles, choisissez ceux du jeu puis confirmez. Si un appareil manque, utilisez « Autre / saisie manuelle » : les champs restent toujours accessibles.', 'Detect available devices, choose those used by the game, then confirm. If a device is missing, use “Other / manual entry”: the fields always remain available.', hardware);
        this.text('p', 'Une guitare peut apparaître comme périphérique USB, composite USB ou HID, sans porter son nom habituel. Ces propositions ne prouvent pas quel contrôleur le jeu utilise.', 'A guitar may appear as a USB, composite USB or HID device without its usual name. These suggestions do not prove which controller the game uses.', hardware);
        const hardwareChanged = () => { this.hardwareConfirmed.checked = false; this.comparable.checked = false; this.render(); };
        for (const [select, field, flag] of [[this.hardwareOutputChoice, this.hardwareOutput, 'hardwareOutputManual'], [this.hardwareInputChoice, this.hardwareInput, 'hardwareInputManual']]) {
            this.listen(select, 'change', () => { this[flag] = select.value === '__manual__'; if (select.value && !this[flag]) field.value = select.value; hardwareChanged(); if (this[flag]) field.focus(); });
            this.listen(field, 'input', () => { this[flag] = true; hardwareChanged(); });
        }
        this.listen(this.hardwareNote, 'input', hardwareChanged);
        this.listen(this.hardwareDisplay, 'change', hardwareChanged);
        this.listen(this.hardwareConfirmed, 'change', () => {
            if (this.hardwareConfirmed.checked && (!this.hardwareOutput.value.trim() || !this.hardwareInput.value.trim())) {
                this.hardwareConfirmed.checked = false;
                this.showFeedback('Renseignez la sortie audio et la guitare ou le clavier utilisés avant de confirmer.', 'Enter the audio output and guitar or keyboard used before confirming.');
            }
            this.render();
        });
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
            void this.run('telemetry.calibrationStart', { stage: this.stage.value, settingMs: Number(this.setting.value), source: this.calibrationSource(), ...(this.hardwareContext() ? { hardwareContext: this.hardwareContext() } : {}) }); });
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
        } else {
            this.connectorSetup = new ConnectorSetupControls(this, root);
        }
        this.feedback = this.node('p', this.calibrationBeta ? calibrationRoot || root : root, 'performance-feedback');
        this.feedback.hidden = true;
        this.feedback.setAttribute('role', 'status');
        if (dedicatedCalibration) { this.summaryFeedback = this.node('p', root, 'performance-summary-feedback'); this.summaryFeedback.hidden = true; this.summaryFeedback.setAttribute('role', 'status'); }
        this.render();
    }
    tr(fr, en) { return this.language === 'en' ? en : fr; }
    feedbackNodes() { return [this.feedback, this.summaryFeedback].filter(Boolean); }
    showFeedback(fr, en) { this.feedbackMessage = [fr, en]; for (const node of this.feedbackNodes()) { node.textContent = this.tr(fr, en); node.classList.remove('is-error'); node.hidden = false; } }
    format(value, decimals = 1) { return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(this.language, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value) : '—'; }
    calibrationSource() { return this.method.value === 'gameplay' ? 'gameplay' : 'tool'; }
    hardwareContext() {
        if (!this.hardwareConfirmed?.checked) return null;
        const display = this.snapshot?.hardware?.displays?.find(value => value.key === this.hardwareDisplay.value);
        return { version: 1, audioOutput: this.hardwareOutput.value.trim(), input: this.hardwareInput.value.trim(), display: display ? { key: display.key, label: display.label, widthPx: display.widthPx, heightPx: display.heightPx, refreshHz: display.refreshHz } : null, note: this.hardwareNote.value.trim() };
    }
    hardwareSummary(context) {
        if (!context) return this.tr('configuration non renseignée', 'setup not recorded');
        const display = context.display;
        return context.audioOutput + ' · ' + context.input + (display ? ' · ' + display.label + ' ' + display.widthPx + '×' + display.heightPx + (display.refreshHz ? ' · ' + this.format(display.refreshHz) + ' Hz' : '') : '') + (context.note ? ' · ' + context.note : '');
    }
    matchingHardware(a, b) {
        if (!a && !b) return true;
        if (!a || !b || (this.stage.value === 'video' && (!a.display || !b.display))) return false;
        const identity = context => [context.audioOutput, context.input, context.display?.key, context.display?.label, context.display?.widthPx, context.display?.heightPx, context.display?.refreshHz, context.note];
        return JSON.stringify(identity(a)) === JSON.stringify(identity(b));
    }
    async refreshHardware() {
        if (!this.hardwareRefresh || this.hardwareRefreshPending || this.snapshot?.hardware?.status === 'checking' || this.disposed) return;
        this.hardwareRefreshPending = true; this.hardwareRefreshError = false; this.renderHardware();
        try { const result = await this.command('telemetry.hardwareRefresh', {}); if (!result?.ok) this.hardwareRefreshError = true; }
        catch { this.hardwareRefreshError = true; }
        finally { this.hardwareRefreshPending = false; if (!this.disposed) this.renderHardware(); }
    }
    renderHardware() {
        if (!this.hardwareRefresh) return;
        const h = this.snapshot?.hardware, displays = h?.displays || [], outputs = h?.outputs || (h?.audio?.outputName ? [{ name: h.audio.outputName, windowsDefault: true }] : []), inputs = h?.inputs || [];
        const checking = this.hardwareRefreshPending || h?.status === 'checking';
        this.hardwareRefresh.disabled = checking;
        this.hardwareRefresh.title = checking ? this.tr('Détection en cours ; attendez la fin de la lecture.', 'Detection in progress; wait for the reading to finish.') : '';
        this.hardwareStatus.textContent = checking ? this.tr('Lecture du matériel… La détection n’exige pas de connexion à Clone Hero.', 'Reading hardware… Detection does not require a Clone Hero connection.') : this.hardwareRefreshError ? this.tr('Détection indisponible. Réessayez ou utilisez les champs manuels ci-dessous.', 'Detection unavailable. Retry or use the manual fields below.') : h?.checkedAt ? this.tr('Informations système actualisées à la demande. Choisissez les appareils réellement utilisés, puis confirmez.', 'System information refreshed on request. Choose the devices actually used, then confirm.') : this.tr('Aucune détection effectuée. Cliquez sur Détecter ou renseignez votre matériel manuellement.', 'No detection performed. Click Detect or enter your hardware manually.');
        const identity = JSON.stringify([h?.audio, outputs, displays, inputs]);
        if (identity !== this.hardwareIdentity) {
            const selected = this.hardwareDisplay.value;
            this.hardwareIdentity = identity; this.hardwareConfirmed.checked = false; this.comparable.checked = false;
            this.hardwareDisplay.replaceChildren();
            const unknown = this.node('option', this.hardwareDisplay); unknown.value = '';
            for (const display of displays) {
                const option = this.node('option', this.hardwareDisplay); option.value = display.key;
            }
            this.hardwareDisplay.value = displays.some(display => display.key === selected) ? selected : '';
            this.hardwareInputList.replaceChildren();
            for (const candidate of inputs) this.node('option', this.hardwareInputList).value = candidate.name;
            for (const [select, candidates] of [[this.hardwareOutputChoice, outputs], [this.hardwareInputChoice, inputs]]) {
                select.replaceChildren(); this.node('option', select).value = '';
                for (const candidate of candidates) this.node('option', select).value = candidate.name;
                this.node('option', select).value = '__manual__';
            }
        }
        for (const [select, field, candidates, manual] of [[this.hardwareOutputChoice, this.hardwareOutput, outputs, this.hardwareOutputManual], [this.hardwareInputChoice, this.hardwareInput, inputs, this.hardwareInputManual]]) {
            select.options[0].textContent = candidates.length ? this.tr('Choisir dans la liste · aucun appareil confirmé', 'Choose from the list · no device confirmed') : this.tr('Aucun appareil détecté · saisie manuelle disponible', 'No device detected · manual entry available');
            for (let index = 0; index < candidates.length; index++) {
                const candidate = candidates[index], categories = { input: ['Entrée candidate', 'Input candidate'], 'usb-device': ['Appareil USB candidat', 'USB device candidate'], 'usb-bus': ['Bus / concentrateur USB · à identifier', 'USB bus / hub · identify before choosing'], hid: ['Périphérique HID candidat', 'HID device candidate'] };
                select.options[index + 1].textContent = candidate.name + (candidate.windowsDefault ? this.tr(' · défaut Windows, à vérifier', ' · Windows default, verify in game') : categories[candidate.category] ? ' · ' + this.tr(...categories[candidate.category]) : '');
            }
            select.options[select.options.length - 1].textContent = this.tr('Autre / saisie manuelle', 'Other / manual entry');
            select.value = manual || (field.value && !candidates.some(candidate => candidate.name === field.value)) ? '__manual__' : candidates.some(candidate => candidate.name === field.value) ? field.value : '';
        }
        this.hardwareDisplay.options[0].textContent = this.tr('Non renseigné / détection indisponible', 'Not recorded / detection unavailable');
        for (let index = 0; index < displays.length; index++) {
            const d = displays[index];
            this.hardwareDisplay.options[index + 1].textContent = d.label + ' · ' + d.widthPx + '×' + d.heightPx + this.tr(' px (mode système)', ' px (system mode)') + (d.refreshHz ? ' · ' + this.format(d.refreshHz) + ' Hz' : '') + (d.appDisplay ? this.tr(' · écran de ChartsHub', ' · ChartsHub display') : '');
        }
        const a = h?.audio;
        this.hardwareOutput.placeholder = a?.outputName || this.tr('Ex. casque USB ou haut-parleurs', 'e.g. USB headset or speakers');
        this.hardwareAudio.textContent = this.tr('Audio · défaut Windows (à confirmer pour le jeu) : ', 'Audio · Windows default (confirm for the game): ') + (a?.outputName || this.tr('indisponible', 'unavailable')) + (a?.sampleRateHz ? ' · ' + this.format(a.sampleRateHz, 0) + ' Hz · ' + a.channels + ' ' + this.tr('canaux', 'channels') : '') + (a?.defaultPeriodMs ? this.tr(' · période moteur par défaut (partagé) ', ' · default engine period (shared) ') + this.format(a.defaultPeriodMs, 2) + ' ms' : '') + (a?.minimumPeriodMs ? this.tr(' · période minimale (exclusif) ', ' · minimum period (exclusive) ') + this.format(a.minimumPeriodMs, 2) + ' ms' : '') + '. ' + this.tr('Ces périodes ne mesurent pas le retard des haut-parleurs ni le trajet audio du jeu.', 'These periods do not measure speaker delay or the game’s audio path.');
        const d = displays.find(display => display.key === this.hardwareDisplay.value);
        this.hardwareVideo.textContent = d ? this.tr('Vidéo · écran choisi : ', 'Video · selected display: ') + d.label + (d.refreshHz ? ' · ' + this.format(d.refreshHz) + ' Hz · ' + this.tr('intervalle de rafraîchissement ', 'refresh interval ') + this.format(d.frameIntervalMs, 2) + ' ms' : '') + '. ' + this.tr('La fréquence ne mesure pas le retard physique, le traitement TV ou la synchronisation du jeu.', 'Refresh rate does not measure physical delay, TV processing or game synchronization.') : this.tr('Vidéo · choisissez l’écran du jeu dans la liste. Seul l’écran de ChartsHub est repéré ; celui du jeu n’est pas identifié automatiquement.', 'Video · select the game display in the list. Only the ChartsHub display is marked; the game display is not identified automatically.');
        this.hardwareInputs.textContent = this.tr('Entrées candidates · ', 'Input candidates · ') + ((h?.inputs || []).map(input => input.name).join(' · ') || this.tr('indisponibles ; saisie manuelle possible', 'unavailable; manual entry is available')) + '. ' + this.tr('Le système ne mesure pas leur délai de frappe.', 'The system does not measure their input delay.');
    }
    nativeResult(stage) {
        const p = this.snapshot, result = p?.connected && p?.capabilities?.calibrationResults && p?.calibration?.nativeResults?.[stage];
        return result && Number.isSafeInteger(result.settingMs) && result.settingMs >= -2000 && result.settingMs <= 2000 && Number.isSafeInteger(result.sampleCount) && result.sampleCount > 0 && result.source === 'native-calibration' ? result : null;
    }
    signed(value) { return (value > 0 ? '+' : '') + this.format(value) + ' ms'; }
    trialMetrics(result) { return this.tr('moyenne signée', 'signed mean') + ' ' + this.signed(result.meanOffsetMs) + (result.meanOffsetMs < 0 ? this.tr(' (tôt)', ' (early)') : result.meanOffsetMs > 0 ? this.tr(' (tard)', ' (late)') : '') + ' · ' + this.tr('écart absolu', 'absolute offset') + ' ' + this.format(result.meanAbsoluteOffsetMs) + ' ms · ' + this.tr('dispersion', 'deviation') + ' ' + this.format(result.standardDeviationMs) + ' ms'; }
    async run(name, payload, clear = false) {
        if (this.gameplayMeasurements === false || this.busy || this.disposed)
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
                throw Error(name.startsWith('telemetry.connector') ? this.tr('Cette étape n’a pas pu être terminée. Consultez l’indication de l’assistant.', 'This step could not finish. See the setup assistant’s guidance.') : result?.error || this.tr('Cette action n’a pas pu être appliquée.', 'This action could not be applied.'));
            if (clear)
                this.dirty = false;
            this.showFeedback(...(name === 'telemetry.calibrationStart' ? ['Essai démarré. Aucun réglage du jeu n’a été changé.', 'Trial started. No game setting was changed.'] : name === 'telemetry.calibrationFinish' ? ['Essai conservé dans l’historique de ce réglage et de cette méthode.', 'Trial kept in the history for this setting and method.'] : ['Action terminée.', 'Action completed.']));
        }
        catch (error) {
            if (!this.disposed) {
                this.feedbackMessage = null;
                for (const node of this.feedbackNodes()) { node.textContent = error?.message || this.tr('Réessayez dans un instant.', 'Please try again shortly.'); node.classList.add('is-error'); node.hidden = false; }
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
        if (this.gameplayMeasurements === false) return;
        for (const [node, fr, en] of this.labels)
            node.textContent = this.tr(fr, en);
        if (this.feedbackMessage) for (const node of this.feedbackNodes()) node.textContent = this.tr(...this.feedbackMessage);
        const p = this.snapshot, connected = p?.connected === true, c = p?.capabilities || {};
        this.connectorSetup.render();
        if (this.calibrationBeta) this.renderHardware();
        const status = { disabled: ['Mesures désactivées', 'Measurements disabled'], waiting: ['Connecteur non connecté', 'Connector not connected'], connecting: ['Connexion au jeu…', 'Connecting to game…'], connected: ['Mesures réelles connectées', 'Real measurements connected'], unsupported: ['Version du jeu non validée', 'Game version not validated'], stale: ['Mesures interrompues', 'Measurements interrupted'], error: ['Connexion aux mesures indisponible', 'Measurements unavailable'] }[p?.status || 'waiting'];
        this.status.textContent = this.tr(...status) + (p?.gameVersion ? ' · Clone Hero ' + p.gameVersion : '');
        this.status.dataset.connected = String(connected);
        this.enabled.checked = p?.enabled === true;
        this.enabled.disabled = this.busy || !p || p.canWrite === false;
        if (this.calibrationEnabled) { this.calibrationEnabled.checked = this.enabled.checked; this.calibrationEnabled.disabled = this.enabled.disabled; this.calibrationStatus.textContent = this.status.textContent; this.calibrationStatus.dataset.connected = String(connected); }
        const timing = p?.timing || {};
        for (const [key, node] of Object.entries(this.metrics)) {
            const value = timing[key];
            node.textContent = this.format(value, key === 'sampleCount' ? 0 : 1) + (typeof value === 'number' ? (key === 'sampleCount' ? '' : key === 'withinWindowPercent' ? ' %' : ' ms') : '');
        }
        this.coverage.textContent = !connected ? this.tr('Les valeurs sont masquées quand la source est interrompue.', 'Values are hidden when the source is interrupted.') : ['idle', 'menu', 'loading'].includes(p.phase) ? timing.sampleCount > 0 ? this.tr('Aucune chart en cours · dernières mesures conservées.', 'No chart in progress · previous measurements retained.') : this.tr('En attente d’une chart · aucune mesure de frappe reçue.', 'Waiting for a chart · no hit measurement received.') : this.tr('Décalage négatif : tôt. Positif : tard. ', 'Negative offset: early. Positive: late. ') + (timing.coverage === 'complete' ? this.tr('Mesures depuis le début de l’essai.', 'Measured from the start of the attempt.') : timing.coverage === 'since-connect' ? this.tr('Mesures depuis la connexion.', 'Measured since connection.') : this.tr('Mesures partielles après une interruption.', 'Partial measurements after an interruption.'));
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
        if (p?.persistenceError && !this.busy) {
            this.feedbackMessage = null;
            for (const node of this.feedbackNodes()) { node.textContent = p.persistenceError; node.classList.add('is-error'); node.hidden = false; }
        }
        if (!this.calibrationBeta) return;
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
            this.tr('Recopiez la valeur ci-dessous et démarrez l’essai ChartsHub, puis lancez la chart. Les mesures commencent à la première frappe reçue. Vous pouvez aussi démarrer avant les frappes d’un passage déjà lancé.', 'Enter the value below and start the ChartsHub trial, then start the chart. Measurements begin with the first received hit. You can also start before the hits of a passage already running.'),
            this.tr('Jouez au moins 30 frappes continues, sans redémarrer ni déplacer la lecture, puis terminez l’essai. Pour comparer, changez seulement le réglage ' + settingName + ' dans le jeu et rejouez le même passage à la même vitesse.', 'Play at least 30 continuous hits without restarting or seeking, then finish the trial. To compare, change only the ' + settingName + ' setting in the game and replay the same passage at the same speed.')
        ] : [
            this.tr('Dans Clone Hero, relevez le réglage ' + settingName + ' actuel. Recopiez-le ci-dessous et démarrez l’essai ChartsHub.', 'In Clone Hero, read the current ' + settingName + ' setting. Enter it below and start the ChartsHub trial.'),
            this.tr('Ouvrez Réglages → Gameplay → Calibration, puis utilisez l’outil natif. Seules les mesures ' + settingName + ' reçues de cet outil sont comptées.', 'Open Settings → Gameplay → Calibration, then use the native tool. Only ' + settingName + ' measurements received from that tool are counted.'),
            this.tr('Après au moins 30 mesures continues du même essai natif, terminez ici pour conserver les mesures. Un nouvel essai ou un changement audio/vidéo impose de recommencer le compteur.', 'After at least 30 continuous measurements from the same native trial, finish here to keep the measurements. A new native trial or an audio/video change requires a fresh counter.')
        ];
        const setup = this.hardwareContext();
        instructions.unshift(audio ? this.tr('Gardez la même sortie audio et la même connexion pendant les essais. ', 'Keep the same audio output and connection throughout the trials. ') + (setup ? this.tr('Configuration confirmée : ', 'Confirmed setup: ') + this.hardwareSummary(setup) : this.tr('Vérifiez dans le jeu la sortie réellement utilisée ; le défaut Windows peut être différent.', 'Check the actual output in the game; the Windows default may differ.')) : this.tr('Gardez le même écran, la même fréquence, le même mode Jeu/TV et la même synchronisation. ', 'Keep the same display, refresh rate, Game/TV mode and synchronization. ') + (setup?.display ? this.tr('Écran confirmé : ', 'Confirmed display: ') + this.hardwareSummary(setup) : this.tr('Choisissez et confirmez l’écran du jeu dans la rubrique matériel si vous souhaitez conserver ce contexte.', 'Select and confirm the game display in the hardware section to keep this context.')));
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
        const trialStatus = !connected || trial?.incomplete ? this.tr('Interruption : recommencez cet essai.', 'Interrupted: restart this trial.') : !matchingTrial ? this.tr('Choisissez ce réglage et cette méthode pour terminer cet essai.', 'Choose this setting and method to finish this trial.') : trial?.state === 'waiting-chart' ? this.tr('En attente du début de la chart. Lancez la chart dans le jeu.', 'Waiting for the chart to start. Start the chart in the game.') : trial?.state === 'waiting-hit' ? this.tr('Jouez : les mesures commencent à la première frappe reçue.', 'Play: measurements begin with the first received hit.') : '';
        this.trial.textContent = trial ? this.tr(trial.stage === 'audio' ? 'Essai audio' : 'Essai vidéo', trial.stage === 'audio' ? 'Audio trial' : 'Video trial') + ' · ' + this.tr(trial.source === 'gameplay' ? 'frappes en jeu' : 'outil du jeu', trial.source === 'gameplay' ? 'chart hits' : 'game tool') + ' · ' + this.format(trial.settingMs) + ' ms · ' + this.format(trial.sampleCount, 0) + '/30 ' + this.tr('mesures', 'measurements') + (trialStatus ? ' · ' + trialStatus : '') : !connected ? this.tr('Connectez les mesures réelles pour démarrer un essai.', 'Connect real measurements to start a trial.') : !(gameplay ? c.hitTiming : c.calibrationTiming) ? this.tr('Cette méthode nécessite des mesures compatibles avec le connecteur.', 'This method requires compatible connector measurements.') : this.tr('Aucun essai en cours. Terminer devient disponible à partir de 30 mesures continues.', 'No trial running. Finish becomes available after 30 continuous measurements.');
        this.liveTrial.hidden = !connected || !matchingTrial || trial?.incomplete || !trial?.sampleCount;
        this.liveTrial.textContent = this.liveTrial.hidden ? '' : this.trialMetrics(trial);
        this.historyTitle.textContent = this.tr('Historique ' + settingName + ' · ' + (gameplay ? 'analyse en jeu' : 'outil du jeu'), (audio ? 'Audio' : 'Video') + ' history · ' + (gameplay ? 'in-game analysis' : 'game tool'));
        const results = (p?.calibration?.trials || []).filter(result => result.stage === this.stage.value && result.source === source);
        this.trials.replaceChildren();
        for (const result of results) {
            const li = this.node('li', this.trials);
            li.textContent = this.tr('Réglage saisi', 'Entered setting') + ' ' + this.format(result.settingMs) + ' ms · ' + this.trialMetrics(result) + ' · ' + this.format(result.sampleCount, 0) + ' ' + this.tr('mesures', 'measurements') + (result.hardwareContext ? ' · ' + this.tr('matériel confirmé : ', 'confirmed hardware: ') + this.hardwareSummary(result.hardwareContext) : '');
        }
        const comparisonIdentity = JSON.stringify([this.stage.value, source, results.slice(0, 2)]);
        if (this.comparisonIdentity !== comparisonIdentity) { this.comparable.checked = false; this.comparisonIdentity = comparisonIdentity; }
        this.emptyHistory.hidden = results.length > 0;
        this.emptyHistory.textContent = this.tr('Aucun essai conservé pour ce réglage et cette méthode.', 'No trials kept for this setting and method.');
        const regularity = connected && matchingTrial && !trial.incomplete && trial.sampleCount >= 30 ? trial : results[0];
        this.regularity.hidden = !regularity || regularity.sampleCount < 30 || !Number.isFinite(regularity.standardDeviationMs);
        this.regularity.textContent = this.regularity.hidden ? '' : this.tr('Régularité de l’essai', 'Trial consistency') + ' · ' + this.tr('dispersion', 'deviation') + ' ' + this.format(regularity.standardDeviationMs) + ' ms. ' + this.tr('Une faible dispersion indique des frappes plus régulières. Refaites plusieurs essais dans les mêmes conditions pour vérifier que les moyennes restent proches.', 'Lower deviation means more consistent hits. Repeat trials under the same conditions to check that the means remain close.');
        const hardwareMatches = results.length >= 2 && this.matchingHardware(results[0].hardwareContext, results[1].hardwareContext);
        this.comparable.disabled = results.length < 2 || !hardwareMatches;
        if (!hardwareMatches) this.comparable.checked = false;
        this.comparison.textContent = results.length < 2 ? this.tr('Conservez deux essais de ce réglage avec cette méthode pour comparer avant et après.', 'Keep two trials for this setting and method to compare before and after.') : !hardwareMatches ? this.tr('Configurations différentes ou incomplètes : conservez deux nouveaux essais avec le même matériel confirmé avant de comparer.', 'Different or incomplete setups: keep two new trials with the same confirmed hardware before comparing.') : !this.comparable.checked ? this.tr('Vérifiez les conditions identiques ci-dessus pour comparer les deux derniers essais.', 'Confirm the matching conditions above to compare the two latest trials.') : this.tr('Avant', 'Before') + ' · ' + this.format(results[1].settingMs) + ' ms · ' + this.trialMetrics(results[1]) + '\n' + this.tr('Après', 'After') + ' · ' + this.format(results[0].settingMs) + ' ms · ' + this.trialMetrics(results[0]) + '\n' + this.tr('Variation de l’écart absolu moyen', 'Change in mean absolute offset') + ' : ' + this.signed(results[0].meanAbsoluteOffsetMs - results[1].meanAbsoluteOffsetMs) + '. ' + this.tr('Une baisse rapproche les frappes de zéro, sans déterminer à elle seule le bon réglage.', 'A decrease brings hits closer to zero, without determining the right setting on its own.');
    }
    dispose() { this.disposed = true; for (const remove of this.listeners)
        remove(); }
}
