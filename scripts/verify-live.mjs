/**
 * Live verification of the `/ask` mode against a RUNNING dsh web instance.
 *
 * It speaks the same HTTP RPC the browser does: the Typert gateway answers unary
 * Remote calls at `POST /api/<namespace>/<method>` with a
 * `{type:'client-request', rpcId, method, payload:{args}}` body, authenticated by
 * the browser-session cookie the `?token=` index exchange issues. No browser and
 * no dependency beyond `node:` is needed.
 *
 *   1. `session/create`        — a live agent to command
 *   2. `commands/list`         — `/ask` is registered, with its description and hint
 *   3. `commands/execute`      — `/ask`, `/ask off`, and the attachment rejection
 *   4. `session/list`          — the live `ask` projection value (`{active,pending}`)
 *   5. `session/page`          — the `/ask` command records the mode is derived from,
 *                                and that the log holds no plugin-defined event type
 *                                (one would make the session unloadable after a restart)
 *
 * With `--model-turns` it also drives two real turns: one under `/ask` that asks
 * for a file to be created (it must not be, and the mode must end with the
 * turn), then an ordinary message with no `/ask` (it must create the file).
 *
 * Usage:
 *   node scripts/verify-live.mjs --url "http://127.0.0.1:PORT/?token=TOKEN" \
 *     [--workspace DIR] [--model-turns] [--probe-file NAME]
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** A valid 4x4 PNG (generated with sharp), so attachment admission accepts the image. */
const SAMPLE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8AARwgWXg4ArpMP8bh5W0YAAAAASUVORK5CYII=';

/** Parse `--flag value` / `--flag` arguments. */
function parseArgs(argv) {
  const options = { modelTurns: false, probeFile: 'ask-mode-probe.txt', timeoutMs: 180_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (key === 'modelTurns') {
      options.modelTurns = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.url === undefined) throw new Error('pass --url "<the URL dsh web printed>"');

const base = new URL(options.url).origin;
const token = new URL(options.url).searchParams.get('token');
const results = [];
const ok = (message) => { results.push(['ok', message]); process.stdout.write(`ok: ${message}\n`); };
const fail = (message) => { results.push(['fail', message]); process.stdout.write(`FAIL: ${message}\n`); };
const info = (message) => process.stdout.write(`   ${message}\n`);

// ── transport ────────────────────────────────────────────────────────────────

let cookie = '';

/** Exchange the URL token for the browser-session cookie. */
async function authorize() {
  if (token === null) throw new Error('the URL carries no ?token=');
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  if (raw === undefined || raw === null) throw new Error(`no session cookie issued (HTTP ${response.status})`);
  return raw.split(';')[0];
}

/** One unary Remote call; resolves to `{ok:true,value}` or `{ok:false,error}`. */
async function rpc(endpoint, args) {
  const rpcId = randomUUID();
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status} ${text.slice(0, 200)}`);
  const envelope = JSON.parse(text);
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error(`${endpoint}: bad envelope`);
  return envelope.result;
}

/** Call and unwrap, throwing on a Remote failure. */
async function call(endpoint, args) {
  const result = await rpc(endpoint, args);
  if (result.ok !== true) throw new Error(`${endpoint} failed: ${result.error?.code} ${result.error?.message}`);
  return result.value;
}

/** Run `/command` through the live command registry. */
const command = (sessionId, line, submittedAttachments = []) =>
  call('commands/execute', { agentId: sessionId, line, submittedAttachments });

/** The session's live projection cut: `{ running, asOfSeq, values }`. */
async function liveState(sessionId) {
  const listed = await call('session/list', { _request: {} });
  const entry = listed.items.find((item) => item.sessionId === sessionId);
  if (entry === undefined) throw new Error(`session ${sessionId} is not listed`);
  return {
    running: entry.running === true,
    asOfSeq: entry.projections.asOfSeq,
    values: entry.projections.values,
  };
}

/** Every session-log event up to the current cut. */
async function sessionEvents(sessionId) {
  const state = await liveState(sessionId);
  const page = await call('session/page', {
    request: {
      address: { kind: 'session', sessionId },
      throughSeq: state.asOfSeq,
      maxMessages: 500,
    },
  });
  return page.records.filter((record) => record.type === 'event').map((record) => record.event);
}

/** Wait until the session stops running and has produced an assistant message. */
async function waitForTurnEnd(sessionId) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const state = await liveState(sessionId);
    if (state.running) continue;
    const events = await sessionEvents(sessionId);
    if (events.some((event) => event.type === 'assistant/message')) return { events, settled: true };
    return { events, settled: false };
  }
  return { events: await sessionEvents(sessionId), settled: false };
}

// ── the checks ───────────────────────────────────────────────────────────────

/**
 * Whether an event type belongs to the harness vocabulary. A session event type
 * this plugin invented (`ask/mode`, in version 0.1.x) cannot be marked
 * `ignorable` through `Session.append()`, and the persistence reader refuses a
 * log containing one — so the absence of foreign types is what keeps a session
 * loadable after a restart, and it is asserted on every run.
 */
function noForeignType(type) {
  return !type.includes('ask/');
}

/** The `/ask` command records in a log, which is what the mode is derived from. */
const askRuns = (events) => events.filter((event) => event.type === 'command/run' && event.data.name === 'ask');

async function main() {
  cookie = await authorize();
  ok('exchanged the URL token for a browser-session cookie');

  const workspace = options.workspace ?? process.cwd();
  const created = await call('session/create', { request: { cwd: workspace } });
  const sessionId = created.sessionId;
  ok(`created a live session ${sessionId} (preset ${created.agentPreset ?? 'default'})`);

  const commands = await call('commands/list', { agentId: sessionId });
  const names = commands.map((entry) => entry.name);
  const ask = commands.find((entry) => entry.name === 'ask');
  if (ask === undefined) {
    fail(`/ask is not registered; the session sees: ${names.join(', ')}`);
    return;
  }
  ok(`/ask is registered among ${names.length} commands: ${names.join(', ')}`);
  info(`description: ${ask.description}`);
  info(`input: ${JSON.stringify(ask.input)}`);
  if (/read-only/i.test(ask.description)) ok('the description advertises the read-only stance');
  else fail(`unexpected description ${JSON.stringify(ask.description)}`);
  if (ask.input?.hint === '[off|message]' && ask.input?.attachments === true) ok('the input hint and attachment support are advertised');
  else fail(`unexpected input descriptor ${JSON.stringify(ask.input)}`);

  const before = await liveState(sessionId);
  if (before.values.ask === undefined) fail('the live session exposes no `ask` projection value');
  else if (before.values.ask.active !== false) fail(`ask mode starts active: ${JSON.stringify(before.values.ask)}`);
  else ok(`the live ask projection starts at ${JSON.stringify(before.values.ask)}`);

  const on = await command(sessionId, '/ask');
  if (on?.result?.kind === 'success' && /Ask mode on \(read-only\)/.test(on.result.text ?? '')) ok(`/ask → ${on.result.text}`);
  else fail(`/ask returned ${JSON.stringify(on)}`);

  const afterOn = await liveState(sessionId);
  if (afterOn.values.ask?.active === true && afterOn.values.ask?.pending === false) ok(`the projection now reports ${JSON.stringify(afterOn.values.ask)}`);
  else fail(`expected {active:true,pending:false}, saw ${JSON.stringify(afterOn.values.ask)}`);

  const onAgain = await command(sessionId, '/ask');
  if (/already on/.test(onAgain?.result?.text ?? '')) ok(`/ask twice → ${onAgain.result.text}`);
  else fail(`/ask twice returned ${JSON.stringify(onAgain)}`);

  const offWithImage = await command(sessionId, '/ask off', [{ type: 'image', mediaType: 'image/png', data: SAMPLE_PNG }]);
  if (offWithImage?.result?.kind === 'error' && /Attachments cannot accompany/.test(offWithImage.result.text ?? '')) {
    ok(`/ask off with an image → error: ${offWithImage.result.text}`);
  } else fail(`/ask off with an image returned ${JSON.stringify(offWithImage)}`);

  // The rejected /ask off must not have changed the mode.
  const afterRejected = await liveState(sessionId);
  if (afterRejected.values.ask?.active === true) ok('the rejected /ask off left the mode on');
  else fail(`the rejected /ask off changed the mode: ${JSON.stringify(afterRejected.values.ask)}`);

  const eventsWhileOn = await sessionEvents(sessionId);
  const runs = eventsWhileOn.filter((event) => event.type === 'command/run' && event.data.name === 'ask');
  if (runs.length === 3) ok(`the session log recorded ${runs.length} /ask invocations`);
  else fail(`expected 3 /ask command records, saw ${runs.length}`);
  if (eventsWhileOn.every((event) => noForeignType(event.type))) {
    ok('every event in the log belongs to the harness vocabulary (no plugin-defined types)');
  } else {
    const foreign = [...new Set(eventsWhileOn.map((event) => event.type))].filter((type) => !noForeignType(type));
    fail(`the log carries plugin-defined event type(s) ${foreign.join(', ')}, which would make it unloadable after a restart`);
  }

  const off = await command(sessionId, '/ask off');
  if (off?.result?.kind === 'success' && /Ask mode off/.test(off.result.text ?? '')) ok(`/ask off → ${off.result.text}`);
  else fail(`/ask off returned ${JSON.stringify(off)}`);

  const afterOff = await liveState(sessionId);
  if (afterOff.values.ask?.active === false) ok(`the projection now reports ${JSON.stringify(afterOff.values.ask)}`);
  else fail(`expected {active:false,...}, saw ${JSON.stringify(afterOff.values.ask)}`);
  const runsAfterOff = (await sessionEvents(sessionId)).filter((event) => event.type === 'command/run' && event.data.name === 'ask');
  if (runsAfterOff.length === 4) ok(`the log holds ${runsAfterOff.length} /ask records, and the state is derived from them`);
  else fail(`expected 4 /ask command records, saw ${runsAfterOff.length}`);

  // ── optional real model turns ──────────────────────────────────────────────

  if (options.modelTurns) {
    const probePath = join(workspace, options.probeFile);
    const guidance = (events) => events.filter((event) => event.type === 'system/message'
      && JSON.stringify(event).includes('You are in ask mode'));

    // Turn 1: `/ask` without a message arms the mode for the turn the next
    // prompt starts, and the mode must end on its own when that turn stops.
    await command(sessionId, '/ask');
    await call('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: `Create a file named ${options.probeFile} in the current working directory containing exactly: hello` }],
      },
    });
    const askTurn = await waitForTurnEnd(sessionId);
    const denied = JSON.stringify(askTurn.events).includes('ask mode is read-only');
    if (!askTurn.settled) fail('the ask-mode turn did not settle before the timeout');
    if (guidance(askTurn.events).length === 0) fail('the ask turn’s system prompt carried no ask-mode guidance');
    else ok('the ask turn’s system prompt carried the ask-mode guidance');
    if (existsSync(probePath)) fail(`ask mode created ${options.probeFile} — the mode is not read-only`);
    else ok(`ask mode did not create ${options.probeFile}${denied ? ' (the guard denied the write)' : ' (the model declined to act)'}`);

    const afterTurn = await liveState(sessionId);
    const eventsAfterTurn = await sessionEvents(sessionId);
    if (afterTurn.values.ask?.active === false) ok('ask mode ended with its turn, with no /ask off');
    else fail(`ask mode outlived its turn: ${JSON.stringify(afterTurn.values.ask)}`);
    const endsWithTurnEnd = eventsAfterTurn.filter((event) => event.type === 'turn/end').length > 0;
    if (endsWithTurnEnd) ok('the release is the turn/end event the harness itself logged');
    else fail('the ask turn logged no turn/end event');

    // Turn 2: an ordinary message — no /ask, no /ask off — must be able to act.
    await call('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'Now create that file.' }],
      },
    });
    const plainTurn = await waitForTurnEnd(sessionId);
    if (!plainTurn.settled) fail('the follow-up turn did not settle before the timeout');
    if (existsSync(probePath)) ok(`the next message without /ask created ${options.probeFile}`);
    else fail('a plain follow-up message was still refused (a model or tooling problem, not a mode problem)');
    const latest = plainTurn.events.filter((event) => event.type === 'system/message').at(-1);
    const latestCarriesGuidance = latest !== undefined && JSON.stringify(latest).includes('You are in ask mode');
    if (!latestCarriesGuidance) ok('and its request carried no ask-mode guidance');
    else fail('the follow-up request still carried ask-mode guidance');
  }
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// ── verdict ──────────────────────────────────────────────────────────────────

const failures = results.filter(([kind]) => kind === 'fail');
process.stdout.write(`\n${results.length - failures.length}/${results.length} checks passed\n`);
process.exit(failures.length === 0 ? 0 : 1);
