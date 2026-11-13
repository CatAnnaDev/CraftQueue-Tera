const fs = require("fs");
const path = require("path");

const PIE_ID = 206023;
const PIE_AB_ID = 70264;
const GUARD_MS = 8000;

module.exports = function CraftQueue(mod) {
	const command = mod.command || mod.require.command;
	const recipes = loadJson("recipes.json");
	const items = loadJson("items.json");
	const STEPS_FILE = path.join(__dirname, "data", "steps.json");
	const CONFIG_FILE = path.join(__dirname, "config.json");
	let steps = loadFile(STEPS_FILE) || {};
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
		chain: { names: [], counts: [], idx: -1, active: false }
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
		if (st.chain.active && st.chain.idx < st.chain.names.length - 1) {
			return advanceChain();
		}
		stop(reason);
	}

	function advanceChain() {
		st.chain.idx++;
		const name = st.chain.names[st.chain.idx];
		const count = st.chain.counts[st.chain.idx] || 0;
		if (!steps[name]) return stop(`chain step "${name}" not learned`);
		loadStep(name, count);
		say(`Chain step ${st.chain.idx + 1}/${st.chain.names.length}: ${name}${count ? " x" + count : " (until out of mats)"}`);
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
			if (!st.cureDbid) return stop("production points exhausted (set a cure: craft pp <item link>)");
			say("Restoring production points.");
			st.extraDelay += 10;
			mod.setTimeout(() => {
				useItem(cfg.cureId, st.cureDbid);
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

	function startChain(args) {
		const names = [], counts = [];
		for (const a of args) {
			const [n, c] = a.split(":");
			const key = Object.keys(steps).find(k => k.toLowerCase() === n.toLowerCase());
			if (!key) return say(`Step "${n}" not learned. Learn it: craft one ${n} then "craft learn ${n}".`);
			names.push(key); counts.push(parseInt(c, 10) || 0);
		}
		if (!names.length) return say("Usage: craft chain <name1> <name2:count> ...");
		st.chain = { names, counts, idx: -1, active: true };
		st.enabled = true;
		say(`Chain: ${names.join(" -> ")}`);
		advanceChain();
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
			say(`Craft queue: ${st.enabled ? "ON" : "off"}${st.chain.active ? " [chain " + (st.chain.idx + 1) + "/" + st.chain.names.length + "]" : ""} | step ${statName()} ${st.done}${st.target ? "/" + st.target : ""} | pp ${Number.isFinite(st.pp) ? st.pp : "?"} | reagent ${reagent.field ? (reagent.on ? "on" : "off") : "n/a"}`);
			say(infoText());
		},
		info() { say(infoText()); },
		pie() { cfg.reUsePie = !cfg.reUsePie; saveConfig(); say(`Moongourd Pie reuse: ${cfg.reUsePie ? "on" : "off"}`); },
		delay(n) {
			const d = parseInt(n, 10);
			if (Number.isInteger(d) && d >= 0) { cfg.delay = d; saveConfig(); say(`Delay ${d} ms.`); } else say(`Current delay ${cfg.delay} ms.`);
		},
		pp(link) {
			const id = /#(\d+)@/.exec(link || ""), dbid = /@(\d+)@/.exec(link || "");
			if (id && dbid) { cfg.cureId = parseInt(id[1], 10); st.cureDbid = BigInt(parseInt(dbid[1], 10)); saveConfig(); say(`PP cure set: ${nameOf(cfg.cureId)}.`); }
			else say("Link the cure item: craft pp <item link>");
		},
		$default(arg) {
			const n = parseInt(arg, 10);
			if (Number.isInteger(n) && n > 0) return begin(n);
			say("craft (toggle) | <N> | max | chain <a b c> | learn <name> | steps | forget <name> | reagent on|off | calibrate | stats [reset] | status | info | delay <ms> | pie | pp <link>");
		}
	});

	this.destructor = () => {
		clearTimeout(st.timer);
		clearTimeout(st.guard);
		command.remove("craft");
	};
};
