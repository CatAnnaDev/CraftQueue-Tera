const fs = require("fs");
const path = require("path");

const PIE_ID = 206023;
const PIE_AB_ID = 70264;
const GUARD_MS = 8000;

module.exports = function CraftQueue(mod) {
	const command = mod.command || mod.require.command;
	const recipes = loadJson("recipes.json");
	const items = loadJson("items.json");
	const ppItems = loadJson("pp_items.json");
	const STEPS_FILE = path.join(__dirname, "data", "steps.json");
	const PRESETS_FILE = path.join(__dirname, "data", "presets.json");
	const CONFIG_FILE = path.join(__dirname, "config.json");
	let steps = loadFile(STEPS_FILE) || {};
	let presets = loadFile(PRESETS_FILE) || {};
	const cfg = Object.assign({ delay: 0, reUsePie: false, cureId: 0, ppThreshold: 1000, progressEvery: 25 }, readConfig());
	mod.game.initialize("inventory");

	function readConfig() {
		if (mod.settings && typeof mod.settings === "object") return mod.settings;
		try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch (e) { return {}; }
	}
	function saveConfig() {
		if (mod.settings && typeof mod.settings === "object") return;
		try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 4)); } catch (e) { mod.warn("config save error: " + e.message); }
	}

	const st = {
		enabled: false,
		craftItem: null,
		recipe: null,
		recipeKey: null,
		currentName: "craft",
		target: 0,
		done: 0,
		runCrits: 0,
		pp: Infinity,
		usePie: false,
		cureDbid: 0n,
		loc: { x: 0, y: 0, z: 0 },
		w: 0,
		extraDelay: 0,
		timer: null,
		guard: null,
		chain: { list: [], idx: -1, active: false, name: null }
	};

	const stats = { crafts: 0, crits: 0, byRecipe: {} };
	const reagent = { on: false, field: null, onVal: null, offVal: null };
	const calib = { active: false, a: null };
	let learnPending = null;

	function loadJson(f) {
		try { return JSON.parse(fs.readFileSync(path.join(__dirname, "data", f), "utf8")); } catch (e) { return {}; }
	}
	function loadFile(f) {
		try { return reviveBig(JSON.parse(fs.readFileSync(f, "utf8"))); } catch (e) { return null; }
	}
	function saveSteps() {
		try { fs.writeFileSync(STEPS_FILE, JSON.stringify(replaceBig(steps))); } catch (e) { mod.warn("steps save error: " + e.message); }
	}
	function savePresets() {
		try { fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 4)); } catch (e) { mod.warn("presets save error: " + e.message); }
	}

	function replaceBig(o) {
		if (typeof o === "bigint") return { __b: o.toString() };
		if (Array.isArray(o)) return o.map(replaceBig);
		if (o && typeof o === "object") { const r = {}; for (const k of Object.keys(o)) r[k] = replaceBig(o[k]); return r; }
		return o;
	}
	function reviveBig(o) {
		if (o && typeof o === "object") {
			if (typeof o.__b === "string" && Object.keys(o).length === 1) return BigInt(o.__b);
			if (Array.isArray(o)) return o.map(reviveBig);
			const r = {}; for (const k of Object.keys(o)) r[k] = reviveBig(o[k]); return r;
		}
		return o;
	}
	function cloneEvent(o) { return reviveBig(replaceBig(o)); }

	const say = m => command.message(m);
	const nameOf = id => (items[id] ? items[id].n : `#${id}`);

	function gold(n) {
		n = Math.round(n);
		const g = Math.floor(n / 10000), s = Math.floor((n % 10000) / 100), c = n % 100;
		return [g && g + "g", s && s + "s", (c || (!g && !s)) && c + "c"].filter(Boolean).join(" ");
	}

	function invAmount(id) {
		try { return mod.game.inventory.getTotalAmountInBagOrPockets(id); } catch (e) { return 0; }
	}

	function cureName(id) { return (ppItems[String(id)] && ppItems[String(id)].n) || nameOf(id); }
	function curePP(id) { return ppItems[String(id)] ? ppItems[String(id)].pp : 0; }
	function cureInBag(id) {
		try { return mod.game.inventory.findInBagOrPockets(id); } catch (e) { return null; }
	}
	function chooseCure() {
		if (cfg.cureId) { const f = cureInBag(cfg.cureId); if (f && f.amount > 0) return { id: cfg.cureId, dbid: f.dbid }; }
		let best = null;
		for (const idStr of Object.keys(ppItems)) {
			const id = parseInt(idStr, 10);
			const f = cureInBag(id);
			if (f && f.amount > 0 && (!best || curePP(id) > best.pp)) best = { id, dbid: f.dbid, pp: curePP(id) };
		}
		return best;
	}
	function ppStatus() {
		say(`PP: ${Number.isFinite(st.pp) ? st.pp : "?"} | seuil ${cfg.ppThreshold} | cure ${cfg.cureId ? cureName(cfg.cureId) : "auto"}`);
		const rows = Object.keys(ppItems).map(k => ({ id: k, n: ppItems[k].n, pp: ppItems[k].pp })).sort((a, b) => b.pp - a.pp);
		for (const r of rows) {
			const f = cureInBag(parseInt(r.id, 10));
			const have = f && f.amount > 0 ? "x" + f.amount : "-";
			say(`  ${r.id}  +${r.pp} PP  ${r.n}  [${have}]`);
		}
		say("Set: craft pp <id|nom>  (auto-pioche n'importe quelle dispo si non defini)");
	}

	function identifyRecipe(ev) {
		for (const k of Object.keys(ev)) {
			const v = ev[k];
			const n = typeof v === "bigint" ? Number(v) : (typeof v === "number" ? v : NaN);
			if (Number.isFinite(n) && recipes[String(n)]) return { id: String(n), key: k };
		}
		return null;
	}

	function materialRuns(recipe) {
		if (!recipe || !recipe.m.length) return Infinity;
		let runs = Infinity;
		for (const [id, cnt] of recipe.m) runs = Math.min(runs, Math.floor(invAmount(id) / Math.max(1, cnt)));
		return runs;
	}
	function limitingMaterial(recipe) {
		if (!recipe) return null;
		let best = null, bestRuns = Infinity;
		for (const [id, cnt] of recipe.m) {
			const runs = Math.floor(invAmount(id) / Math.max(1, cnt));
			if (runs < bestRuns) { bestRuns = runs; best = id; }
		}
		return best;
	}

	function applyReagent(packet) {
		if (!reagent.field) return packet;
		const p = cloneEvent(packet);
		p[reagent.field] = reagent.on ? reagent.onVal : reagent.offVal;
		return p;
	}

	function sendCraft() {
		clearTimeout(st.guard);
		mod.send("C_START_PRODUCE", VER.start, applyReagent(st.craftItem));
		st.guard = mod.setTimeout(() => {
			if (st.enabled) stepEnd("no response (blocked, inventory full, or out of materials)");
		}, GUARD_MS + (cfg.delay || 0) + st.extraDelay);
	}

	function unlockClient() {
		try { mod.send("S_START_PRODUCE", VER.sStart, { duration: 0 }); } catch (e) { return; }
	}

	function statName() { return st.currentName || "craft"; }
	function bucket() {
		const n = statName();
		if (!stats.byRecipe[n]) stats.byRecipe[n] = { crafts: 0, crits: 0 };
		return stats.byRecipe[n];
	}

	function stop(reason) {
		st.enabled = false;
		st.chain.active = false;
		clearTimeout(st.timer);
		clearTimeout(st.guard);
		unlockClient();
		say(`Craft stopped: ${reason}.`);
		say(`Session: ${stats.crafts} crafts, ${stats.crits} crit (${pct(stats.crits, stats.crafts)}).`);
	}

	function pct(a, b) { return b ? Math.round((a / b) * 100) + "%" : "0%"; }

	function stepEnd(reason) {
		if (st.chain.active && st.chain.idx < st.chain.list.length - 1) {
			return advanceChain();
		}
		stop(reason);
	}

	function applyStepReagent(on) {
		if (typeof on !== "boolean") return;
		if (!reagent.field) { if (on) say("(reagent demande mais non calibre; lance: craft calibrate)"); return; }
		reagent.on = on;
	}

	function advanceChain() {
		st.chain.idx++;
		const step = st.chain.list[st.chain.idx];
		if (!recipes[String(step.recipeId)]) return stop(`chain step "${step.label}" unknown recipe`);
		applyStepReagent(step.reagent);
		loadRecipe(step.recipeId, step.count);
		const tag = step.reagent === true ? " +reagent" : step.reagent === false ? " -reagent" : "";
		say(`Chain step ${st.chain.idx + 1}/${st.chain.list.length}: ${step.label}${step.count ? " x" + step.count : " (until out of mats)"}${tag}`);
		sendCraft();
	}

	function loadStep(name, count) {
		st.craftItem = cloneEvent(steps[name].packet);
		st.currentName = name;
		st.target = count || 0;
		st.done = 0;
		st.runCrits = 0;
		st.extraDelay = 0;
		const rid = identifyRecipe(st.craftItem);
		st.recipe = rid ? recipes[rid.id] : null;
		st.recipeKey = rid ? rid.key : null;
	}

	function useItem(id, dbid) {
		mod.send("C_USE_ITEM", VER.useItem, {
			gameId: mod.game.me.gameId, id, dbid, target: 0, amount: 1,
			dest: { x: 0, y: 0, z: 0 }, loc: st.loc, w: st.w,
			unk1: 0, unk2: 0, unk3: 0, unk4: true
		});
	}

	function decideNext() {
		if (!st.enabled) return;
		if (st.target && st.done >= st.target) return stepEnd(`${statName()} reached ${st.target}`);
		if (materialRuns(st.recipe) <= 0) return stepEnd(`${statName()} out of materials (${nameOf(limitingMaterial(st.recipe))})`);
		clearTimeout(st.timer);
		st.timer = mod.setTimeout(sendCraft, (cfg.delay || 0) + st.extraDelay);
	}

	function defVer(name, fallback) {
		try { const v = mod.dispatch.latestDefVersion.get(name); return v === undefined ? fallback : v; } catch (e) { return fallback; }
	}
	function hook(name, fallback, cb) {
		let v = fallback;
		try { const latest = mod.dispatch.latestDefVersion.get(name); if (latest === undefined) { mod.warn(`skip hook ${name}: no definition on this client`); return; } v = latest; } catch (e) { v = fallback; }
		try { mod.hook(name, v, cb); } catch (e) { mod.warn(`skip hook ${name} v${v}: ${e.message}`); }
	}
	const VER = { start: defVer("C_START_PRODUCE", 1), useItem: defVer("C_USE_ITEM", 3), sStart: defVer("S_START_PRODUCE", 3) };

	hook("C_PLAYER_LOCATION", 5, event => { Object.assign(st.loc, event.loc); st.w = event.w; });

	hook("S_ABNORMALITY_END", 1, event => {
		if (event.id === PIE_AB_ID && cfg.reUsePie && mod.game.me.is(event.target)) st.usePie = true;
	});

	hook("S_FATIGABILITY_POINT", 3, event => { st.pp = event.fatigability; });

	hook("C_START_PRODUCE", 1, event => {
		if (calib.active) {
			if (!calib.a) {
				calib.a = cloneEvent(event);
				say("Reagent calibration: captured OFF sample. Now craft the SAME recipe once WITH reagent lv2.");
			} else {
				const diff = Object.keys(event).find(k => !isObj(event[k]) && String(event[k]) !== String(calib.a[k]));
				if (diff) {
					reagent.field = diff; reagent.offVal = calib.a[diff]; reagent.onVal = event[diff];
					say(`Reagent field learned: "${diff}" (off=${calib.a[diff]}, on=${event[diff]}). Use: craft reagent on|off`);
				} else {
					say("Could not detect a reagent field (no scalar changed). Try again.");
				}
				calib.active = false; calib.a = null;
			}
			return;
		}
		st.craftItem = event;
		const rid = identifyRecipe(event);
		st.recipe = rid ? recipes[rid.id] : null;
		st.recipeKey = rid ? rid.key : null;
		st.currentName = st.recipe && st.recipe.r[0] ? nameOf(st.recipe.r[0]) : "craft";
		if (learnPending) {
			const name = learnPending; learnPending = null;
			steps[name] = { packet: cloneEvent(event), recipeId: rid ? rid.id : null, result: st.recipe ? st.recipe.r[0] : 0 };
			saveSteps();
			say(`Learned step "${name}"${st.recipe ? " -> " + nameOf(st.recipe.r[0]) : ""}.`);
		}
	});

	hook("S_PRODUCE_CRITICAL", 1, () => { st.runCrits++; stats.crits++; bucket().crits++; });

	hook("S_END_PRODUCE", 1, event => {
		clearTimeout(st.guard);
		if (!event.success) { if (st.enabled) stepEnd(`${statName()} craft failed (materials or conditions)`); return; }
		stats.crafts++; bucket().crafts++;
		if (!st.enabled) return;

		st.done++;
		st.extraDelay = 0;
		const every = cfg.progressEvery || 0;
		if (every > 0 && st.done % every === 0) {
			const runs = materialRuns(st.recipe);
			say(`${statName()}: ${st.done}${st.target ? "/" + st.target : ""} (session crit ${stats.crits}${Number.isFinite(runs) ? ", ~" + runs + " runs left" : ""})`);
		}

		if (st.target && st.done >= st.target) return stepEnd(`${statName()} reached ${st.target}`);
		if (materialRuns(st.recipe) <= 0) return stepEnd(`${statName()} out of materials (${nameOf(limitingMaterial(st.recipe))})`);

		if (st.usePie) {
			st.usePie = false;
			const pie = mod.game.inventory.findInBagOrPockets(PIE_ID);
			if (pie && pie.amount > 0) { st.extraDelay = 5000; say("Reapplying Moongourd Pie."); mod.setTimeout(() => useItem(PIE_ID, pie.dbid), st.extraDelay / 2); }
		}

		if (st.pp < (cfg.ppThreshold || 1000)) {
			const cure = chooseCure();
			if (!cure) return stop("production points exhausted (aucune potion PP en sac; craft pp pour la liste)");
			if (cure.id !== cfg.cureId) { cfg.cureId = cure.id; saveConfig(); }
			say(`Restoring PP: ${cureName(cure.id)} (+${curePP(cure.id)}).`);
			st.extraDelay += 10;
			mod.setTimeout(() => {
				useItem(cure.id, cure.dbid);
				mod.hookOnce("S_FATIGABILITY_POINT", defVer("S_FATIGABILITY_POINT", 3), () => { if (st.enabled) sendCraft(); });
			}, 5 + st.extraDelay);
		} else {
			decideNext();
		}
	});

	function begin(target) {
		st.chain.active = false;
		st.target = target || 0;
		st.done = 0;
		st.runCrits = 0;
		st.extraDelay = 0;
		st.enabled = true;
		if (st.craftItem) { sendCraft(); say(`Crafting${st.target ? " " + st.target : " endlessly"}${st.recipe ? " -> " + nameOf(st.recipe.r[0]) : ""}.`); }
		else say(`Ready${st.target ? " for " + st.target : ""}: craft one item manually to start.`);
	}

	function parseStepToken(tok) {
		const parts = tok.split(":");
		const name = parts[0];
		let count = 0, reagent;
		for (const p of parts.slice(1)) {
			const low = p.toLowerCase();
			if (low === "r" || low === "reagent") reagent = true;
			else if (low === "nr" || low === "noreagent") reagent = false;
			else { const n = parseInt(p, 10); if (Number.isInteger(n) && n > 0) count = n; }
		}
		return { name, count, reagent };
	}

	function buildRecipePacket(recipeId) { return { recipe: Number(recipeId), unk: 0 }; }

	function craftLabel(recipeId) {
		const rec = recipes[String(recipeId)];
		const resId = rec && rec.r[0];
		return (resId && items[resId] && items[resId].n) || ("recipe " + recipeId);
	}

	function recipeIdForName(name) {
		const lc = name.toLowerCase();
		let partial = null;
		for (const rid of Object.keys(recipes)) {
			const resId = recipes[rid].r[0];
			const nm = items[resId] && items[resId].n;
			if (!nm) continue;
			const nl = nm.toLowerCase();
			if (nl === lc) return rid;
			if (!partial && nl.includes(lc)) partial = rid;
		}
		return partial;
	}

	function resolveCraftByName(str) {
		const name = str.trim();
		if (/^\d+$/.test(name)) {
			if (recipes[name]) return { recipeId: name, label: craftLabel(name) };
			return { error: `Recipe id ${name} unknown.` };
		}
		const stepKey = Object.keys(steps).find(k => k.toLowerCase() === name.toLowerCase());
		if (stepKey && steps[stepKey].recipeId) return { recipeId: String(steps[stepKey].recipeId), label: stepKey };
		const rid = recipeIdForName(name);
		if (rid) return { recipeId: rid, label: craftLabel(rid) };
		return { error: `Unknown craft "${name}" (id de recette, nom de resultat, ou step appris). Cherche: craft recipes ${name}` };
	}

	function resolveSteps(tokens) {
		const list = [];
		for (const t of tokens) {
			const s = parseStepToken(t);
			const r = resolveCraftByName(s.name);
			if (r.error) return { error: r.error };
			list.push({ recipeId: r.recipeId, label: r.label, count: s.count, reagent: s.reagent });
		}
		return { list };
	}

	function stepLabel(s) {
		return s.label + (s.count ? ":" + s.count : "") + (s.reagent === true ? "+r" : s.reagent === false ? "-r" : "");
	}

	function loadRecipe(recipeId, count) {
		st.craftItem = buildRecipePacket(recipeId);
		st.recipe = recipes[String(recipeId)] || null;
		st.recipeKey = "recipe";
		st.currentName = craftLabel(recipeId);
		st.target = count || 0;
		st.done = 0;
		st.runCrits = 0;
		st.extraDelay = 0;
	}

	function runChainList(list, presetName) {
		st.chain = { list, idx: -1, active: true, name: presetName || null };
		st.enabled = true;
		say(`${presetName ? 'Preset "' + presetName + '"' : "Chain"}: ${list.map(stepLabel).join(" -> ")}`);
		advanceChain();
	}

	function startChain(args) {
		if (!args.length) return say("Usage: craft chain <name1> <name2:count> ... (suffixe :r reagent, :nr sans)");
		const r = resolveSteps(args);
		if (r.error) return say(r.error);
		runChainList(r.list, null);
	}

	function presetCmd(sub, args) {
		if (sub === "save") {
			const name = args.shift();
			if (!name || !args.length) return say("Usage: craft preset save <nom> <step1> <step2:count:r> ...");
			const r = resolveSteps(args);
			if (r.error) return say(r.error);
			presets[name] = r.list;
			savePresets();
			return say(`Preset "${name}" saved: ${r.list.map(stepLabel).join(" -> ")}`);
		}
		if (sub === "run" || sub === "start") {
			const key = args[0] && Object.keys(presets).find(k => k.toLowerCase() === args[0].toLowerCase());
			if (!key) return say(`Preset "${args[0] || ""}" not found. craft preset list`);
			const missing = presets[key].filter(s => !recipes[String(s.recipeId)]);
			if (missing.length) return say(`Preset "${key}" has unknown recipes: ${missing.map(s => s.label).join(", ")}`);
			return runChainList(presets[key].map(s => ({ recipeId: s.recipeId, label: s.label, count: s.count, reagent: s.reagent })), key);
		}
		if (sub === "list") {
			const keys = Object.keys(presets);
			if (!keys.length) return say("No presets. craft preset save <nom> <steps...>");
			say(`Presets (${keys.length}):`);
			return keys.forEach(k => say(`  ${k}: ${presets[k].map(stepLabel).join(" -> ")}`));
		}
		if (sub === "del" || sub === "delete") {
			const key = args[0] && Object.keys(presets).find(k => k.toLowerCase() === args[0].toLowerCase());
			if (!key) return say(`Preset "${args[0] || ""}" not found.`);
			delete presets[key]; savePresets(); return say(`Deleted preset "${key}".`);
		}
		if (sub === "reagent") {
			const key = args[0] && Object.keys(presets).find(k => k.toLowerCase() === args[0].toLowerCase());
			if (!key) return say(`Preset "${args[0] || ""}" not found.`);
			const q = (args[1] || "").toLowerCase();
			const step = presets[key].find(s => s.label.toLowerCase() === q || String(s.recipeId) === q);
			if (!step) return say(`Step "${args[1] || ""}" not in preset "${key}".`);
			step.reagent = args[2] === "on" ? true : args[2] === "off" ? false : undefined;
			savePresets();
			return say(`Preset "${key}" step "${step.label}" reagent: ${step.reagent === true ? "on" : step.reagent === false ? "off" : "default"}`);
		}
		say("craft preset save|run|list|del|reagent <...>");
	}

	function isObj(v) { return v && typeof v === "object"; }

	function statsText() {
		const lines = [`Session: ${stats.crafts} crafts, ${stats.crits} crit (${pct(stats.crits, stats.crafts)})`];
		for (const n of Object.keys(stats.byRecipe)) {
			const b = stats.byRecipe[n];
			lines.push(`  ${n}: ${b.crafts} crafts, ${b.crits} crit (${pct(b.crits, b.crafts)})`);
		}
		return lines;
	}

	function infoText() {
		if (!st.recipe) return st.craftItem ? "Recipe not identified (loop still works)." : "No craft captured yet. Craft one item once.";
		const r = st.recipe;
		const mats = r.m.map(([id, c]) => `${nameOf(id)} x${c} (have ${invAmount(id)})`).join(", ");
		return `${nameOf(r.r[0])} x${r.r[1]} | crit ${nameOf(r.c[0])} x${r.c[1]} | mats: ${mats} | max runs: ${materialRuns(r)}`;
	}

	command.add("craft", {
		$none() { st.enabled ? stop("manual") : begin(0); },
		stop() { st.enabled ? stop("manual") : say("Not crafting."); },
		max() {
			if (!st.craftItem || !st.recipe) return say("Craft one item manually first, then: craft max");
			const runs = materialRuns(st.recipe);
			if (runs <= 0) return say(`No materials for ${nameOf(st.recipe.r[0])}.`);
			begin(runs);
		},
		chain(...args) { startChain(args); },
		preset(sub, ...args) { presetCmd(sub, args); },
		make(...args) {
			if (!args.length) return say("Usage: craft make <id|nom de resultat> (puis N optionnel: craft make Elixir 50)");
			let count = 0;
			if (args.length > 1 && /^\d+$/.test(args[args.length - 1])) count = parseInt(args.pop(), 10);
			const r = resolveCraftByName(args.join(" "));
			if (r.error) return say(r.error);
			st.chain.active = false;
			loadRecipe(r.recipeId, count);
			st.enabled = true;
			const runs = materialRuns(st.recipe);
			if (runs <= 0) return stop(`no materials for ${r.label}`);
			say(`Crafting ${r.label}${count ? " x" + count : runs !== Infinity ? " (max " + runs + ")" : " endlessly"}.`);
			sendCraft();
		},
		recipes(...args) {
			const q = args.join(" ").toLowerCase();
			const hits = Object.keys(recipes).filter(rid => {
				if (!q) return true;
				if (String(rid).includes(q)) return true;
				const nm = craftLabel(rid).toLowerCase();
				return nm.includes(q);
			});
			if (!hits.length) return say(`No recipe matches "${q}".`);
			say(`${hits.length} recipe(s)${hits.length > 30 ? " (first 30)" : ""}:`);
			for (const rid of hits.slice(0, 30)) {
				const r = recipes[rid];
				const mats = r.m.map(([id, c]) => `${nameOf(id)}x${c}`).join(", ");
				say(`  ${rid}  ${craftLabel(rid)}  <- ${mats}`);
			}
		},
		learn(name) {
			if (!name) return say("Usage: craft learn <name> (then craft that item once)");
			learnPending = name;
			say(`Now craft "${name}" once to save it as a chain step.`);
		},
		steps() {
			const keys = Object.keys(steps);
			if (!keys.length) return say("No learned steps. Use: craft learn <name>");
			say(`Learned steps (${keys.length}):`);
			keys.forEach(k => say(`  ${k}${steps[k].result ? " -> " + nameOf(steps[k].result) : ""}`));
		},
		forget(name) {
			const key = name && Object.keys(steps).find(k => k.toLowerCase() === name.toLowerCase());
			if (!key) return say(`Step "${name || ""}" not found.`);
			delete steps[key]; saveSteps(); say(`Forgot "${key}".`);
		},
		reagent(state) {
			if (!reagent.field) return say("Reagent field unknown. Run: craft calibrate");
			if (state === "on") reagent.on = true;
			else if (state === "off") reagent.on = false;
			else reagent.on = !reagent.on;
			say(`Reagent lv2: ${reagent.on ? "ON" : "off"}.`);
		},
		calibrate() { calib.active = true; calib.a = null; say("Reagent calibration: craft the recipe once WITHOUT reagent now."); },
		stats(arg) {
			if (arg === "reset") { stats.crafts = 0; stats.crits = 0; stats.byRecipe = {}; return say("Session stats reset."); }
			statsText().forEach(say);
		},
		status() {
			say(`Craft queue: ${st.enabled ? "ON" : "off"}${st.chain.active ? " [" + (st.chain.name ? st.chain.name + " " : "chain ") + (st.chain.idx + 1) + "/" + st.chain.list.length + "]" : ""} | step ${statName()} ${st.done}${st.target ? "/" + st.target : ""} | pp ${Number.isFinite(st.pp) ? st.pp : "?"} | reagent ${reagent.field ? (reagent.on ? "on" : "off") : "n/a"}`);
			say(infoText());
		},
		info() { say(infoText()); },
		pie() { cfg.reUsePie = !cfg.reUsePie; saveConfig(); say(`Moongourd Pie reuse: ${cfg.reUsePie ? "on" : "off"}`); },
		delay(n) {
			const d = parseInt(n, 10);
			if (Number.isInteger(d) && d >= 0) { cfg.delay = d; saveConfig(); say(`Delay ${d} ms.`); } else say(`Current delay ${cfg.delay} ms.`);
		},
		pp(arg) {
			if (!arg) return ppStatus();
			if (arg.toLowerCase() === "auto") { cfg.cureId = 0; saveConfig(); return say("PP cure: auto (pioche la plus grosse dispo)."); }
			const link = /#(\d+)@(\d+)@/.exec(arg);
			if (link) { cfg.cureId = parseInt(link[1], 10); saveConfig(); return say(`PP cure set: ${cureName(cfg.cureId)}.`); }
			let id = parseInt(arg, 10);
			if (!Number.isInteger(id)) {
				const hit = Object.keys(ppItems).find(k => ppItems[k].n.toLowerCase().includes(arg.toLowerCase()));
				if (!hit) return say(`Potion PP inconnue "${arg}". craft pp (sans arg) pour la liste.`);
				id = parseInt(hit, 10);
			}
			if (!ppItems[String(id)]) return say(`${id} n'est pas une potion PP connue.`);
			cfg.cureId = id; saveConfig();
			const f = cureInBag(id);
			say(`PP cure set: ${cureName(id)} (+${curePP(id)} PP)${f && f.amount > 0 ? ", en sac x" + f.amount : " (aucune en sac)"}.`);
		},
		$default(arg) {
			const n = parseInt(arg, 10);
			if (Number.isInteger(n) && n > 0) return begin(n);
			say("craft (toggle) | <N> | make <id|nom> [N] | recipes [search] | max | chain <a b:count c:nr> | preset save|run|list|del|reagent | reagent on|off | calibrate | stats [reset] | status | info | delay <ms> | pie | pp [id|nom|auto] | learn/steps/forget (optionnel)");
		}
	});

	this.destructor = () => {
		clearTimeout(st.timer);
		clearTimeout(st.guard);
		command.remove("craft");
	};
};
