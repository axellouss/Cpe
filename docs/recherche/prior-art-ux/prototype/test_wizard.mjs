// Headless-Chrome test of the UX spike (wizard.html). Run: node test_wizard.mjs
// Proves: the 9-question script yields a complete field set, counts the interactions of the happy path,
// checks FR/DE switch, undo, compass without dragging, tap-to-correct heated zone, expert mode, phone width.
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'out');
fs.mkdirSync(out, { recursive: true });
const url = 'file://' + path.join(here, 'wizard.html');
const results = []; const errors = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 900 });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const S = () => page.evaluate(() => JSON.parse(JSON.stringify({ step: window.__STEPS[window.__state.step], lang: window.__state.lang, answers: window.__state.answers, north: window.__state.plan?.northDeg.v, m: window.__meters(), stats: window.__stats })));
const D = () => page.evaluate(() => window.__derive());
const field = async id => (await D()).find(f => f.id === id);
const click = sel => page.click(sel);
const pct = x => Math.round(x * 100) + ' %';

// ---------- 1. happy path, counting interactions ----------
await page.goto(url);
let s = await S();
check('start: meters at 0', s.m.comp === 0 && s.m.conf === 0);
await click('#b-demo'); s = await S();
const afterPlan = s.m;
check('plan loaded: completeness jumps before any question (fast early progress)', s.m.comp > 0.4, `complete ${pct(s.m.comp)}, confidence ${pct(s.m.conf)}`);
await page.screenshot({ path: path.join(out, 'shot_1_found_fr.png') });
await click('#b-allok');
await click('[data-opt="q1a"]');
s = await S(); check('q1 answered by one tap, auto-advance to q2', s.step === 'q2');
await click('#b-next');                                  // q2: pre-selected period from the plan date
s = await S(); check('q2: period pre-selected from plan date (1974 -> 1969-1983), one tap to accept', s.answers.period === 'p4' && s.step === 'q3');
await page.screenshot({ path: path.join(out, 'shot_2_q3_zone_fr.png') });
await click('#b-next');                                  // q3: heated zone as guessed
await click('#b-next');                                  // q4: nothing renovated
await click('[data-opt="h_lt"]'); await click('[data-opt="a3"]');   // q5
await click('[data-opt="e_rad"]');                       // q6
await click('[data-opt="w_same"]');                      // q7
await click('[data-opt="v_win"]'); await click('#b-next');          // q8
await click('[data-opt="s_none"]');                      // q9
s = await S();
const happy = { ...s.stats };
check('happy path ends on the result screen', s.step === 'result');
let d = await D();
const missing = d.filter(f => f.v === null || f.v === undefined).map(f => f.id);
check('result: every field has a value', missing.length === 0, `${d.length} fields, missing: ${missing.join(',') || 'none'}`);
check('result: completeness meter 100 %', Math.round(s.m.comp * 100) === 100, `confidence ${pct(s.m.conf)}`);
const bySrc = d.reduce((a, f) => (a[f.src] = (a[f.src] || 0) + 1, a), {});
console.log('INFO  fields by source:', JSON.stringify(bySrc), '| interactions happy path:', JSON.stringify(happy));
await page.screenshot({ path: path.join(out, 'shot_3_result_fr.png'), fullPage: true });
fs.writeFileSync(path.join(out, 'export_happy_path.json'), JSON.stringify(await page.evaluate(() => window.__export()), null, 1));
const nFieldsHappy = d.length;
const nQuestions = await page.evaluate(() => window.__STEPS.filter(x => /^q\d/.test(x)).length);
check('question count is under 10', nQuestions < 10, `${nQuestions} questions`);

// copy button gives a decimal comma
await click('[data-copy="An"]');
const copied = await page.evaluate(() => window.__lastCopied);
check('copy button returns the value with a decimal comma', /^\d+,\d$/.test(copied), copied);

// ---------- 2. bilingual switch keeps state ----------
await click('#b-lang'); s = await S();
const hDe = await page.$eval('h1', e => e.textContent);
const rowDe = await page.$eval('[data-field="An"] td', e => e.textContent);
check('language switch FR -> DE re-labels without losing answers', s.lang === 'de' && hDe === 'Erster Entwurf fertig' && rowDe.startsWith('Energiebezugsfläche') && s.answers.heat === 'h_lt', `${hDe} / ${rowDe}`);
await page.screenshot({ path: path.join(out, 'shot_4_result_de.png'), fullPage: true });
await click('#b-lang');

// ---------- 3. undo everywhere ----------
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
s = await S(); check('Ctrl+Z on the result screen returns to q9 and clears the answer', s.step === 'q9' && s.answers.solar === undefined);
await click('#b-undo'); await click('#b-undo'); s = await S();
check('undo button walks back step by step', s.step === 'q8' && s.answers.vent === undefined, `at ${s.step}`);

// ---------- 4. heated zone: tap to correct, live feedback ----------
await page.goto(url); await click('#b-demo'); await click('#b-allok'); await click('[data-opt="q1a"]'); await click('#b-next');
const an0 = (await field('An')).v, ve0 = (await field('Ve')).v;
await click('[data-room="k4"]');
const an1 = (await field('An')).v, ve1 = (await field('Ve')).v;
check('tap one cellar room: An grows, Ve unchanged (level not mostly heated)', Math.abs(an1 - an0 - 22.0) < 0.05 && ve1 === ve0, `An ${an0} -> ${an1} m2, Ve ${ve0} -> ${ve1} m3`);
for (const r of ['k1', 'k2', 'k3']) await click(`[data-room="${r}"]`);
d = await D();
const an2 = d.find(f => f.id === 'An').v, ve2 = d.find(f => f.id === 'Ve').v;
check('whole cellar heated: Ve grows, cellar ceiling replaced by ground slab', ve2 > ve0 && d.some(f => f.id === 'slab') && !d.some(f => f.id === 'cellarceil'), `An ${an2} m2 (+${Math.round((an2 / an0 - 1) * 100)} %), Ve ${ve2} m3 (+${Math.round((ve2 / ve0 - 1) * 100)} %)`);
const live = await page.$eval('#zone-live', e => e.textContent);
check('live read-out under the plan follows the taps', live.includes(String(an2).replace('.', ',')), live);
await page.screenshot({ path: path.join(out, 'shot_5_q3_cellar_heated.png') });
// keyboard alternative for the room toggle
await page.evaluate(() => document.querySelector('[data-room="k1"]').focus()); await page.keyboard.press('Enter');
check('room toggle works from the keyboard (Enter)', Math.abs((await field('An')).v - (an2 - 19.7)) < 0.05);
for (let i = 0; i < 5; i++) await click('#b-undo');
check('five undos restore the guessed zone', (await field('An')).v === an0 && (await field('Ve')).v === ve0);

// ---------- 5. compass: three ways, none requires dragging ----------
await page.goto(url); await click('#b-demo');
const wallIds = async () => (await D()).filter(f => f.id.startsWith('wall_')).map(f => f.id.slice(5) + ':' + f.v).join(' ');   // sector index : opaque wall m2
const w0 = await wallIds();
await click('[data-fix="north"]');
await click('#b-n-plus'); s = await S();
check('compass +15 deg button', s.north === 35);
await click('[data-dir="2"]'); s = await S();
const w1 = await wallIds();
check('compass sector button (plan top faces East) moves the facade areas to other orientations', s.north === 90 && w1 !== w0, `[${w0}] -> [${w1}]`);
await page.evaluate(() => document.querySelector('#compass').focus()); await page.keyboard.press('ArrowRight'); s = await S();
check('compass keyboard arrow', s.north === 105);
const box = await (await page.$('#compass')).boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
s = await S(); check('compass drag (needle dragged to the right = north to the right, plan top faces West)', s.north === 270, `north ${s.north}`);
await page.screenshot({ path: path.join(out, 'shot_6_compass.png') });

// ---------- 6. renovation answer overrides the default and raises confidence ----------
await page.goto(url); await click('#b-demo'); await click('#b-allok'); await click('[data-opt="q1a"]'); await click('#b-next'); await click('#b-next');
const u0 = await field('U_wall');
await click('[data-opt="wall"]');
const u1 = await field('U_wall');
check('"facade insulated" replaces the default wall U-value and its source', u0.v === 1 && u0.src === 'def' && u1.v < 0.3 && u1.src === 'you', `U ${u0.v} (${u0.src}, conf ${u0.conf}) -> ${u1.v} (${u1.src}, conf ${u1.conf})`);
await page.type('#i-wallCm', '20'); await page.keyboard.press('Tab');
check('typing the insulation thickness refines it', (await field('U_wall')).v < u1.v, `U ${(await field('U_wall')).v}`);

// ---------- 7. expert mode escape hatch ----------
await click('#b-expert');
check('expert mode shows the full field table on a question screen', (await page.$('#expert-table')) !== null);
await click('#b-expert');

// ---------- 8. "I do not know" path ----------
await click('#b-next'); await click('[data-opt="h_gc"]'); await click('[data-opt="a1"]'); await click('#b-skip');
const em = await field('emission');
check('"I do not know" gives a default tagged as default with low confidence', em.v === 'e_rad' && em.src === 'def' && em.conf <= 0.5, JSON.stringify(em));

// ---------- 9. phone width: no horizontal scroll ----------
await page.setViewport({ width: 390, height: 800 }); await page.goto(url); await click('#b-demo');
const ovf = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('390 px wide: no horizontal page scroll on the confirm card', ovf <= 0, `overflow ${ovf}px`);
await page.screenshot({ path: path.join(out, 'shot_7_phone.png') });

check('no JavaScript errors', errors.length === 0, errors.join(' | '));
await browser.close();

// ---------- KLM estimate from the measured interaction counts ----------
// Keystroke-Level Model operators (Card, Moran & Newell): K keystroke 0.28 s (average non-secretary typist),
// P point 1.1 s, B mouse button press+release 0.2 s, H homing 0.4 s, M mental preparation 1.35 s. Values from memory.
const K = 0.28, P = 1.1, B = 0.2, H = 0.4, M = 1.35;
const tapCost = M + P + B;                 // decide + point + click
const fieldCost = M + P + B + H + 5 * K + K; // decide + point + click + home + 5 characters + Tab
const nFields = nFieldsHappy;
const klm = {
  wizard_happy_path_s: +(happy.clicks * tapCost + happy.keys * K).toFixed(1),
  same_fields_typed_into_an_empty_form_s: +(nFields * fieldCost).toFixed(1),
  per_tap_s: +tapCost.toFixed(2), per_typed_field_s: +fieldCost.toFixed(2), fields: nFields, clicks: happy.clicks, keys: happy.keys
};
console.log('KLM   ', JSON.stringify(klm));
const summary = { date: new Date().toISOString(), chrome: 'system google-chrome via puppeteer-core', afterPlan, happy, bySrc, nQuestions, klm, results, errors };
fs.writeFileSync(path.join(out, 'wizard_test.json'), JSON.stringify(summary, null, 1));
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
