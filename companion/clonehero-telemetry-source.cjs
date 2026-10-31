'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const contract = require('./clonehero-telemetry-contract.cjs'), { createTelemetryModel, validSettings } = require('./clonehero-telemetry-model.cjs');
const SUPPORTED_BUILDS = Object.freeze([{ version: '1.1.0.6142', runtimeBackend: 'il2cpp', gameAssemblySha256: '12bc21e5a88a2fc9abc259d5d67f24835145eabca6c3f863b075ba37ad75f197', metadataSha256: '5f14231810f2641639167eb72956e85cced2f36cb4a84682bdefb1e9da3e3d42' }]);
const error = code => Object.assign(Error(code), { code });
async function ordinary(file, { limit = 65536, missing = false } = {}) {
    let at = path.parse(file).root;
    for (const piece of file.slice(at.length).split(path.sep).filter(Boolean)) {
        at = path.join(at, piece);
        try {
            if ((await fs.lstat(at)).isSymbolicLink())
                throw error('UNSAFE_LOCAL_SOURCE');
        }
        catch (e) {
            if (e.code === 'ENOENT' && missing)
                return null;
            throw e;
        }
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
        throw error('INVALID_LOCAL_SOURCE');
    const handle = await fs.open(file, require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0));
    try {
        const first = await handle.stat();
        if (first.ino !== stat.ino || first.dev !== stat.dev || first.size !== stat.size || first.mtimeMs !== stat.mtimeMs)
            throw error('UNSTABLE_LOCAL_SOURCE');
        const bytes = Buffer.alloc(limit + 1);
        let n = 0;
        while (n < bytes.length) {
            const read = await handle.read(bytes, n, bytes.length - n, n);
            if (!read.bytesRead)
                break;
            n += read.bytesRead;
        }
        const last = await fs.lstat(file), end = await handle.stat();
        if (n > limit || last.ino !== first.ino || last.dev !== first.dev || last.size !== first.size || last.mtimeMs !== first.mtimeMs || end.size !== first.size || end.mtimeMs !== first.mtimeMs)
            throw error('UNSTABLE_LOCAL_SOURCE');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n));
    }
    finally {
        await handle.close();
    }
}
async function atomic(file, value) { const directory = path.dirname(file); await fs.mkdir(directory, { recursive: true, mode: 0o700 }); let at = path.parse(directory).root; for (const piece of directory.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, piece);
    const stat = await fs.lstat(at);
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw error('UNSAFE_SETTINGS_DIRECTORY');
} const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); if (bytes.length > 512 * 1024)
    throw error('SETTINGS_TOO_LARGE'); await ordinary(file, { limit: 512 * 1024, missing: true }); const temporary = file + '.' + crypto.randomUUID() + '.tmp'; const handle = await fs.open(temporary, 'wx', 0o600); try {
    await handle.writeFile(bytes);
    await handle.sync();
}
finally {
    await handle.close();
} try {
    await fs.rename(temporary, file);
}
finally {
    await fs.unlink(temporary).catch(() => { });
} }
async function createTelemetrySource({ dataDirectory, connectionDirectory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ChartsHub', 'Telemetry', 'v1'), platform = process.platform, supportedBuilds = SUPPORTED_BUILDS, onChange = () => { }, connectTransport = name => net.createConnection('\\\\.\\pipe\\' + name), now = Date.now, pollMs = 2000, staleMs = 5000 } = {}) {
    if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || typeof connectionDirectory !== 'string' || !path.isAbsolute(connectionDirectory) || typeof onChange !== 'function' || !Number.isFinite(pollMs) || pollMs < 10 || pollMs > 60000 || !Number.isFinite(staleMs) || staleMs < 100 || staleMs > 60000)
        throw Error('Configuration de télémétrie invalide.');
    const settingsFile = path.join(dataDirectory, 'clonehero-telemetry.json'), recordsFile = path.join(dataDirectory, 'clonehero-records.json'), descriptorFile = path.join(connectionDirectory, 'connection.json');
    let settings = { windowMs: 20, goal: { kind: 'songs', target: 10 } }, enabled = true, canWrite = true, persistenceError = null, recordsWritable = true;
    try {
        const raw = await ordinary(settingsFile, { limit: 16384, missing: true });
        if (raw) {
            const d = JSON.parse(raw);
            if (!contract.only(d, ['version', 'enabled', 'windowMs', 'goal']) || d.version !== 1 || typeof d.enabled !== 'boolean')
                throw Error('SETTINGS_VERSION');
            settings = validSettings({ windowMs: d.windowMs, goal: d.goal });
            enabled = d.enabled;
        }
    }
    catch {
        canWrite = false;
        enabled = false;
        persistenceError = 'Les réglages de télémétrie existants sont conservés sans modification.';
    }
    const model = createTelemetryModel({ now, settings });
    try {
        const raw = await ordinary(recordsFile, { limit: 512 * 1024, missing: true });
        if (raw)
            model.importRecords(JSON.parse(raw));
    }
    catch {
        recordsWritable = false;
        persistenceError = 'Les anciens records locaux sont conservés sans modification.';
    }
    let wanted = false, disposed = false, generation = 0, socket = null, pollTimer = null, healthTimer = null, notificationTimer = null, persistence = Promise.resolve(), controls = Promise.resolve(), lastPublished = '';
    const snapshot = () => ({ ...model.snapshot(), enabled, canWrite, persistenceError });
    function publish(force = false) { if (disposed)
        return; const value = snapshot(), signature = JSON.stringify(value); if (!force && signature === lastPublished)
        return; lastPublished = signature; try {
        onChange(value);
    }
    catch { /* An observer cannot own the source lifecycle. */ } }
    function schedulePublish() { if (notificationTimer || disposed)
        return; notificationTimer = setTimeout(() => { notificationTimer = null; publish(); }, 16); notificationTimer.unref?.(); }
    function save() { if (!canWrite)
        return Promise.reject(Error('Les réglages sont en lecture seule.')); const copy = { version: 1, enabled, ...structuredClone(settings) }; const next = persistence.then(() => atomic(settingsFile, copy)); persistence = next.catch(() => { }); return next; }
    function saveRecords() { if (!recordsWritable)
        return; const copy = model.exportRecords(); persistence = persistence.then(() => atomic(recordsFile, copy)).catch(() => { recordsWritable = false; persistenceError = 'Les records locaux ne peuvent pas être enregistrés.'; publish(); }); }
    function arm(token) { if (!wanted || disposed || token !== generation || socket)
        return; clearTimeout(pollTimer); pollTimer = setTimeout(() => { pollTimer = null; void attempt(token); }, pollMs); pollTimer.unref?.(); }
    async function attempt(token) {
        if (!wanted || disposed || token !== generation || socket)
            return;
        let descriptor;
        try {
            const raw = await ordinary(descriptorFile, { limit: 4096, missing: true });
            if (!raw) {
                model.connection('waiting', 'PROVIDER_NOT_RUNNING');
                publish();
                arm(token);
                return;
            }
            descriptor = contract.validateDescriptor(JSON.parse(raw));
            if (!contract.supportedGame(descriptor.game, supportedBuilds)) {
                model.connection('unsupported', 'UNVALIDATED_GAME_BUILD');
                publish();
                arm(token);
                return;
            }
        }
        catch {
            if (wanted && token === generation) {
                model.connection('error', 'INVALID_CONNECTION_DESCRIPTOR');
                publish();
                arm(token);
            }
            return;
        }
        if (!wanted || disposed || token !== generation)
            return;
        model.connection('connecting');
        publish();
        let peer;
        try {
            peer = connectTransport(descriptor.pipeName);
        }
        catch {
            model.connection('waiting', 'PROVIDER_NOT_RUNNING');
            publish();
            arm(token);
            return;
        }
        socket = peer;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let pending = '', hello = false, dead = false, lastFrameAt = now(), budgetAt = now(), bytesThisSecond = 0, framesThisSecond = 0, connectionTimer = null;
        const current = () => wanted && !disposed && generation === token && socket === peer && !dead;
        function close(next = 'waiting', code = 'PROVIDER_DISCONNECTED') { if (dead)
            return; dead = true; clearInterval(connectionTimer); if (healthTimer === connectionTimer)
            healthTimer = null; if (socket === peer)
            socket = null; peer.destroy(); if (wanted && !disposed && token === generation) {
            model.connection(next, code);
            publish();
            arm(token);
        } }
        peer.once('connect', () => { if (!current())
            return peer.destroy(); peer.write(JSON.stringify({ schema: 'chartshub.clonehero.handshake.v1', nonce: descriptor.nonce }) + '\n'); });
        peer.on('data', bytes => {
            if (!current())
                return;
            try {
                const at = now();
                if (at - budgetAt >= 1000) {
                    budgetAt = at;
                    bytesThisSecond = 0;
                    framesThisSecond = 0;
                }
                bytesThisSecond += bytes.length;
                if (bytesThisSecond > 1024 * 1024)
                    throw error('TELEMETRY_RATE_LIMIT');
                pending += decoder.decode(bytes, { stream: true });
                if (Buffer.byteLength(pending) > contract.MAX_FRAME_BYTES && !pending.includes('\n'))
                    throw error('TELEMETRY_FRAME_TOO_LARGE');
                let newline;
                while ((newline = pending.indexOf('\n')) >= 0) {
                    const line = pending.slice(0, newline).replace(/\r$/, '');
                    pending = pending.slice(newline + 1);
                    if (!line)
                        continue;
                    if (Buffer.byteLength(line) > contract.MAX_FRAME_BYTES || ++framesThisSecond > 2000)
                        throw error('TELEMETRY_RATE_LIMIT');
                    const frame = contract.validateFrame(JSON.parse(line));
                    if (!contract.sameIdentity(descriptor, frame))
                        throw error('IDENTITY_CHANGED');
                    if (!hello && frame.type !== 'hello')
                        throw error('HELLO_REQUIRED');
                    if (hello && frame.type === 'hello')
                        throw error('DUPLICATE_HELLO');
                    const accepted = model.ingest(frame);
                    hello = true;
                    if (accepted)
                        lastFrameAt = now();
                    if (accepted && frame.type === 'attemptEnd')
                        saveRecords();
                    schedulePublish();
                }
                if (Buffer.byteLength(pending) > contract.MAX_FRAME_BYTES)
                    throw error('TELEMETRY_FRAME_TOO_LARGE');
            }
            catch {
                close('error', 'INVALID_TELEMETRY');
            }
        });
        peer.on('error', () => close('waiting', 'PROVIDER_NOT_RUNNING'));
        peer.on('end', () => close());
        peer.on('close', () => close());
        connectionTimer = setInterval(() => { if (!current())
            return; if (now() - lastFrameAt > (hello ? staleMs : 1500))
            close(hello ? 'stale' : 'error', hello ? 'PROVIDER_STALE' : 'HANDSHAKE_TIMEOUT');
        else
            schedulePublish(); }, Math.max(50, Math.min(1000, staleMs / 2)));
        healthTimer = connectionTimer;
        connectionTimer.unref?.();
    }
    function stop() { wanted = false; ++generation; clearTimeout(pollTimer); clearInterval(healthTimer); clearTimeout(notificationTimer); pollTimer = healthTimer = notificationTimer = null; const peer = socket; socket = null; peer?.destroy(); model.connection(enabled ? 'waiting' : 'disabled', enabled ? 'PROVIDER_NOT_RUNNING' : null); publish(); }
    function start() { if (disposed || wanted || !enabled)
        return; if (platform !== 'win32') {
        model.connection('unsupported', 'PLATFORM_NOT_VALIDATED');
        publish();
        return;
    } wanted = true; const token = ++generation; void attempt(token); }
    async function setEnabled(value) { if (typeof value !== 'boolean')
        throw Error('Activation invalide.'); if (value === enabled) {
        if (value)
            start();
        return snapshot();
    } const before = enabled; enabled = value; if (!enabled)
        stop(); try {
        await save();
    }
    catch (e) {
        enabled = before;
        if (enabled)
            start();
        throw e;
    } if (enabled)
        start(); publish(true); return snapshot(); }
    async function configure(value) { const next = validSettings(value), before = settings; settings = next; try {
        await save();
    }
    catch (e) {
        settings = before;
        throw e;
    } model.configure(settings); publish(true); return snapshot(); }
    function startCalibration(stage, value, source, hardwareContext) { model.startCalibration(stage, value, source, hardwareContext); publish(true); return snapshot(); }
    function finishCalibration() { model.finishCalibration(); publish(true); return snapshot(); }
    function resetSession() { model.resetSession(); publish(true); return snapshot(); }
    function queue(action) { const task = controls.then(() => { if (disposed)
        throw Error('Source fermée.'); return action(); }); controls = task.catch(() => { }); return task; }
    async function dispose() { if (disposed)
        return; stop(); disposed = true; await controls; await persistence; }
    model.connection(enabled ? 'waiting' : 'disabled', enabled ? 'PROVIDER_NOT_RUNNING' : null);
    return { snapshot, start, stop, setEnabled: value => queue(() => setEnabled(value)), configure: value => queue(() => configure(value)), startCalibration, finishCalibration, resetSession, dispose };
}
module.exports = { SUPPORTED_BUILDS, createTelemetrySource, ordinary };
