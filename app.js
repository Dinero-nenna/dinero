// app.js — Dinero's real app: onboarding form + Middager/Matpakke/Handleliste/Inventar tabs,
// ported from matplaner_prototype.html but backed by the live Supabase database via the
// Dinero client (supabase-lite.js) instead of in-memory JS objects.
//
// Everything here is plain vanilla JS (no build step), wrapped in one IIFE that exposes a
// single global, window.DineroApp, with two entry points that index.html calls:
//   DineroApp.showOnboarding(container, household, { firstTime, onDone })
//   DineroApp.showApp(container, household)
//
// Design notes worth knowing before reading further (also in the handoff notes):
//   * Three weeks are modelled: week_key is 'denne' | 'neste' | 'neste2' (this week / next
//     week / the week after). Each is generated once per household (first time there are no
//     week_plan_slots rows for that specific week_key) and then persists/edits from there,
//     exactly as the task asked for ("stable/editable, not recomputed on every reload") —
//     see ensureAllWeeksGenerated(). A household can explicitly force a redo of one week via
//     the "Regenerer …" button (regenerateDinnerWeek()); nothing else ever silently
//     regenerates a week that already has rows. Real calendar rollover (today's date
//     crossing into a new week so "neste" becomes "denne") is NOT implemented — these are
//     three independently-browsable buckets, not date-bound weeks. That's a deliberate,
//     documented follow-up, not an oversight.
//   * "Bytt ut" (swap) and 👍/👎 feedback are faithfully ported: weightedPick(), the
//     feedback-driven weighting (1.6x per net point) and the inventory-aware nudge
//     (1.2x per matching ingredient already at home) are the same math as the prototype.
//     A third, modest nudge (1.15x per matching keyword) now also comes from cuisine_preferences
//     free text — see cuisineKeywords()/cuisineMatchCount() — applied to both initial
//     generation and swaps. Unlike allergies (a hard filter), this is a soft preference.
//   * Allergies are matched with simple case-insensitive substring matching against
//     ingredient names — a first pass, not a real allergen ontology, per the task's brief.

(function () {
  "use strict";

  // ---------- small shared helpers ----------

  function esc(str) {
    // Minimal HTML-escaping for any free text a household typed in (allergies, cuisine
    // preferences, inventory item names, ...) before it goes into innerHTML.
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtIngr(ingr) {
    return (ingr || []).map((i) => (i.a ? i.a + " " : "") + i.n).join(", ");
  }

  function errMsg(e) {
    return (e && e.message) ? e.message : "Noe gikk galt. Prøv igjen.";
  }

  const DAY_LABELS = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];
  const WEEKDAY_LABELS = DAY_LABELS.slice(0, 5);
  const QUICK_MAX_MINUTES = 25;

  // Three independently-generated, persisted week buckets (feedback item 6). Not tied to
  // real calendar dates — see the header note above.
  const WEEK_KEYS = ["denne", "neste", "neste2"];
  const WEEK_LABELS = { denne: "Denne uken", neste: "Neste uke", neste2: "Uken etter" };

  // ---------- vektet tilfeldig trekning (ported from the prototype's weightedPick) ----------
  // Hver 👍 gjør en rett ~1.6x mer sannsynlig å bli trukket neste gang, hver 👎 tilsvarende
  // mindre sannsynlig — men aldri umulig. `ingrLookup`, hvis gitt, legger i tillegg en mild
  // dytt (~1.2x per ingrediens du allerede har hjemme) mot retter som bruker opp inventaret.
  // `cuisineLookup(id)`, if given, returns a match count (see cuisineMatchCount()) that gives
  // a modest ~1.15x-per-match nudge toward dishes touching a household's stated cuisine
  // preferences — a soft preference, deliberately much gentler than the feedback/inventory
  // weights above, and nowhere near as strong as the hard allergy filter applied before this.
  function weightedPick(ids, scoreMap, ingrLookup, cuisineLookup) {
    if (!ids || !ids.length) return null;
    scoreMap = scoreMap || {};
    const weights = ids.map((id) => {
      const fbWeight = Math.pow(1.6, scoreMap[id] || 0);
      const invWeight = ingrLookup ? Math.pow(1.2, inventoryMatchCount(ingrLookup(id))) : 1;
      const cuisineWeight = cuisineLookup ? Math.pow(1.15, cuisineLookup(id)) : 1;
      return fbWeight * invWeight * cuisineWeight;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < ids.length; i++) {
      r -= weights[i];
      if (r <= 0) return ids[i];
    }
    return ids[ids.length - 1];
  }

  function inventoryMatchCount(ingr) {
    return (ingr || []).filter((i) => haveAtHome(i.n)).length;
  }

  function haveAtHome(ingredientName) {
    const lower = (ingredientName || "").toLowerCase();
    return state.inventoryNames.some((itemLower) => itemLower.includes(lower) || lower.includes(itemLower.split(" ")[0]));
  }

  // ---------- allergier: enkel nøkkelord-matching mot ingrediensnavn (ikke en allergen-ontologi) ----------

  // FIX (roadmap #9, 2026-09-02): plain substring matching alone missed obvious word-forms —
  // e.g. "peanøtter" does NOT substring-match "peanøttsmør" (different suffix: peanøtt-ER vs.
  // peanøtt-SMØR), even though anyone with a peanut allergy needs peanøttsmør caught too. A
  // small curated synonym/derivative list per common allergen, keyed by a normalized root —
  // NOT a real allergen ontology (still the app's documented v1/v2 simplification), just the
  // handful of cases a household is actually likely to type. Whichever raw keyword the
  // household typed gets ALL of a matching entry's variants added alongside it (see
  // expandAllergyKeywords() below), so itemMatchesAllergy()'s existing bidirectional substring
  // check (unchanged) now also catches these derived forms.
  const ALLERGY_SYNONYMS = {
    "peanøtt": ["peanøtt", "peanøtter", "peanøttsmør", "peanøttolje", "jordnøtt", "jordnøtter"],
    "peanøtter": ["peanøtt", "peanøtter", "peanøttsmør", "peanøttolje", "jordnøtt", "jordnøtter"],
    "jordnøtt": ["peanøtt", "peanøtter", "peanøttsmør", "peanøttolje", "jordnøtt", "jordnøtter"],
    "jordnøtter": ["peanøtt", "peanøtter", "peanøttsmør", "peanøttolje", "jordnøtt", "jordnøtter"],
    "nøtt": ["nøtt", "nøtter", "mandel", "mandler", "hasselnøtt", "hasselnøtter", "valnøtt", "valnøtter", "cashewnøtt", "cashewnøtter", "pistasj", "pistasjnøtt", "peanøtt", "peanøtter"],
    "nøtter": ["nøtt", "nøtter", "mandel", "mandler", "hasselnøtt", "hasselnøtter", "valnøtt", "valnøtter", "cashewnøtt", "cashewnøtter", "pistasj", "pistasjnøtt", "peanøtt", "peanøtter"],
    "melk": ["melk", "melke", "melkepulver", "melkeprotein", "kumelk", "helmelk", "lettmelk", "skummetmelk", "fløte", "rømme", "yoghurt", "laktose"],
    "melkeprodukt": ["melk", "melke", "melkepulver", "melkeprotein", "kumelk", "helmelk", "lettmelk", "skummetmelk", "fløte", "rømme", "yoghurt", "laktose"],
    "laktose": ["laktose", "melk", "melke", "fløte", "rømme", "yoghurt"],
    "egg": ["egg", "eggehvite", "eggeplomme", "eggerøre"],
    "gluten": ["gluten", "hvete", "hvetemel", "bygg", "rug", "spelt"],
    "hvete": ["hvete", "hvetemel", "gluten"],
    "skalldyr": ["skalldyr", "reke", "reker", "krabbe", "hummer", "kreps", "langust"],
    "bløtdyr": ["bløtdyr", "blåskjell", "østers", "musling", "muslinger", "kamskjell", "blekksprut", "akkar"],
    "fisk": ["fisk", "laks", "torsk", "makrell", "sild", "ørret", "sei", "kveite", "ansjos"],
    "soya": ["soya", "soyasaus", "soyabønne", "soyabønner", "tofu", "edamame"],
    "sesam": ["sesam", "sesamfrø", "sesamolje", "tahini"],
    "selleri": ["selleri", "sellerirot", "sellerifrø"],
    "sennep": ["sennep", "sennepsfrø"],
  };

  function expandAllergyKeywords(rawKeywords) {
    const expanded = new Set();
    rawKeywords.forEach((kw) => {
      expanded.add(kw);
      Object.keys(ALLERGY_SYNONYMS).forEach((key) => {
        if (kw.includes(key) || key.includes(kw)) {
          ALLERGY_SYNONYMS[key].forEach((syn) => expanded.add(syn));
        }
      });
    });
    return Array.from(expanded);
  }

  function allergyKeywords(text) {
    if (!text) return [];
    const raw = text.toLowerCase()
      .split(/[,;.\n]+|\bog\b|\beller\b/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2);
    return expandAllergyKeywords(raw);
  }

  function itemMatchesAllergy(item, keywords) {
    if (!keywords.length) return false;
    // Sides have no `ingredients` array (schema: sides(id, amount, item_name)) — a flat name
    // field instead, unlike dinners/matpakke_items/bake_items. Check that directly so
    // filterAllergySafe() works unmodified on the sides pool too (2026-09-01, "tilbehør
    // filtreres ikke på allergi" fix).
    if (item.item_name) {
      const name = item.item_name.toLowerCase();
      return keywords.some((kw) => name.includes(kw) || kw.includes(name));
    }
    const names = (item.ingredients || []).map((i) => (i.n || "").toLowerCase());
    return keywords.some((kw) => names.some((n) => n.includes(kw) || kw.includes(n)));
  }

  function filterAllergySafe(pool, itemsById, keywords) {
    if (!keywords.length) return pool;
    const safe = pool.filter((id) => !itemMatchesAllergy(itemsById[id], keywords));
    return safe.length ? safe : pool; // never fully lock out a household — fall back rather than show nothing
  }

  // ---------- vegetar: hardt filter, IKKE bare en mild dytt fra fritekst ----------
  // FIX (2026-09-03, Tonje's feedback): a household typing "vi er vegetarianere, spiser ikke
  // kjøtt og fisk" into the free-text cuisine_preferences field only ever got a soft ~1.15x
  // nudge (see cuisineKeywords()/weightedPick() above) — the same mild treatment as someone
  // writing "liker gjerne litt fisk". Free text can't reliably tell a firm restriction apart
  // from a mild like/dislike without real language understanding (that's the deferred
  // internet/AI roadmap item, #2) — so instead this is a dedicated, explicit checkbox
  // (household.vegetar) that hard-filters, exactly like allergies do.
  //
  // Dinners already carry an authoritative `is_veg` boolean set per-recipe at insert time
  // (schema.sql) — spot-checked against all 259 currently-live dinners' actual ingredient
  // lists and found 100% consistent, so it's used directly rather than re-derived from
  // keywords. matpakke_items/bake_items/sides have no such column, so those fall back to the
  // same curated-keyword substring approach as the allergy filter above — same documented
  // limitation (a short list of real words, not a food ontology; a future "vegetarpølse" or
  // similar product could in principle false-match its root word, same class of caveat as the
  // allergy synonym list).
  const MEAT_FISH_KEYWORDS = [
    "kjøtt", "kylling", "svin", "storfe", "biff", "indrefilet", "ytrefilet", "mørbrad", "entrecote",
    "høyrygg", "lamme", "kalv", "elg", "hjort", "reinsdyr", "rådyr", "kalkun", "villsvin", "korv",
    "pølse", "skinke", "bacon", "spekemat", "salami", "pepperoni", "medister", "flesk", "ribbe",
    "leverpostei",
    "fisk", "torsk", "laks", "sei", "makrell", "sild", "ørret", "reke", "skalldyr", "bløtdyr",
    "blåskjell", "østers", "kamskjell", "musling", "blekksprut", "akkar", "kreps", "hummer",
    "krabbe", "langust", "tunfisk", "kaviar", "breiflabb", "piggvar", "abbor", "scampi", "ansjos", "kveite",
  ];

  function filterVegetarian(pool, itemsById, vegetarian) {
    if (!vegetarian) return pool;
    const safe = pool.filter((id) => {
      const item = itemsById[id];
      if (!item) return false;
      if (typeof item.is_veg === "boolean") return item.is_veg; // dinners: authoritative DB flag
      return !itemMatchesAllergy(item, MEAT_FISH_KEYWORDS); // matpakke/bake/sides: keyword fallback
    });
    return safe.length ? safe : pool; // never fully lock a household out — same fallback philosophy as filterAllergySafe()
  }

  // ---------- cuisine-preferences: enkel nøkkelord-matching (mild vekting, ikke et hardt filter) ----------
  const CUISINE_STOPWORDS = new Set([
    "og", "eller", "med", "liker", "gjerne", "mye", "litt", "for", "ikke", "av", "til", "som",
    "er", "vi", "de", "det", "den", "noe", "noen", "alltid", "aldri", "spise", "spiser", "mat",
    "men", "har", "kan", "vil", "skal", "helst", "ofte", "sjelden", "veldig", "ganske", "også",
  ]);
  function cuisineKeywords(text) {
    if (!text) return [];
    return text.toLowerCase()
      .split(/[^a-zæøåA-ZÆØÅ]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && !CUISINE_STOPWORDS.has(s));
  }

  // Counts how many cuisine-preference keywords this dish matches — against its `cuisine`
  // tag (e.g. "asiatisk" -> cuisine === 'Asiatisk') and against its ingredient names, so a
  // preference like "fisk" still nudges fish dishes even though "Fisk" isn't a cuisine tag.
  function cuisineMatchCount(dish, keywords) {
    if (!dish || !keywords || !keywords.length) return 0;
    let count = 0;
    const cuisineLower = (dish.cuisine || "").toLowerCase();
    const ingrNames = (dish.ingredients || []).map((i) => (i.n || "").toLowerCase());
    keywords.forEach((kw) => {
      if (cuisineLower && (cuisineLower.includes(kw) || kw.includes(cuisineLower))) count++;
      else if (ingrNames.some((n) => n.includes(kw))) count++;
    });
    return count;
  }

  function spreadIndices(n, total) {
    n = Math.max(0, Math.min(n, total));
    if (n === 0) return [];
    if (n === total) return Array.from({ length: total }, (_, i) => i);
    const idx = new Set();
    for (let i = 0; i < n; i++) idx.add(Math.round((i * (total - 1)) / Math.max(n - 1, 1)));
    let i = 0;
    while (idx.size < n && i < total) { idx.add(i); i++; }
    return Array.from(idx).sort((a, b) => a - b);
  }

  // Same even-spread math as spreadIndices(), but over an arbitrary list of available
  // positions instead of the fixed range 0..total-1 — lets computeWeekdayTypes() spread
  // home-cooked dinner days evenly across whichever weekdays are LEFT after GodtLevert days
  // are reserved, rather than across all of Man–Fre regardless of GodtLevert.
  function spreadOverIndices(indices, n) {
    n = Math.max(0, Math.min(n, indices.length));
    if (n === 0) return [];
    const positions = spreadIndices(n, indices.length);
    return positions.map((pos) => indices[pos]);
  }

  // Which weekday gets a home-cooked dinner vs. GodtLevert vs. an open/flex day, based on
  // the household's onboarding settings.
  //
  // FIX (feedback item 4): GodtLevert days are reserved FIRST. Home-cooked dinner days are
  // then spread evenly across only the REMAINING weekdays, clamped to however many remain —
  // so a household that picks GodtLevert for Tir/Tor keeps Tir/Tor as GodtLevert no matter
  // how high active_dinners_per_week is, instead of a generic 0–4 spread silently landing a
  // "dinner" day on top of a chosen GodtLevert day. (Previously dinnerIdx was computed first
  // over the fixed Man–Fre range, so GodtLevert days were only "leftovers" that a big enough
  // active_dinners_per_week could and would override.)
  function computeWeekdayTypes(household) {
    const usesGodtlevert = !!household.uses_godtlevert;
    const godtlevertDays = new Set((household.godtlevert_days || []).map((d) => String(d).toLowerCase()));
    const glIndices = [];
    const remainingIndices = [];
    WEEKDAY_LABELS.forEach((label, i) => {
      if (usesGodtlevert && godtlevertDays.has(label.toLowerCase())) glIndices.push(i);
      else remainingIndices.push(i);
    });
    const n = Math.max(1, Math.min(5, household.active_dinners_per_week || 5));
    const dinnerIdx = new Set(spreadOverIndices(remainingIndices, n)); // spreadOverIndices already clamps n to remainingIndices.length
    const types = {};
    WEEKDAY_LABELS.forEach((label, i) => {
      if (glIndices.includes(i)) types[label] = "godtlevert";
      else if (dinnerIdx.has(i)) types[label] = "dinner";
      else types[label] = "flex";
    });
    types["Lør"] = "flex";
    types["Søn"] = "flex";
    return types;
  }

  // ---------- module state (one household "session" at a time — a fresh page load per household) ----------
  const state = {
    household: null,
    uid: null,
    dinners: {}, matpakke: {}, bake: {}, sides: {},
    weekSlots: [],       // week_plan_slots rows for ALL week_keys ('denne'/'neste'/'neste2') for this household
    feedback: { dinner: {}, matpakke: {}, bakst: {} },
    inventory: [],
    inventoryNames: [],  // lowercased inventory_items.item_name, cached for haveAtHome()
    openRecipes: new Set(),      // slot ids with an expanded "Vis oppskrift" box (session-only, not persisted)
    openLibraryRecipes: new Set(), // dinner ids with an expanded "Vis oppskrift" box in the "Deres oppskrifter" list under Middager (session-only)
    feedbackToggle: {},          // "kind:itemId" -> 'up'|'down', session-only button highlight (see report note)
    activeTab: "middager",
    showRecipeForm: false,       // whether the "Legg til oppskrift" form is expanded under Middager (session-only)
    activeWeek: "denne",         // which of WEEK_KEYS is being viewed — shared by Middager and Matpakke tabs
  };
  let libraryLoaded = false;

  function indexById(rows) {
    const out = {};
    (rows || []).forEach((r) => { out[r.id] = r; });
    return out;
  }

  async function ensureLibrary() {
    if (libraryLoaded) return;
    const [dinnersRows, mpRows, bakeRows, sideRows] = await Promise.all([
      Dinero.db("dinners").select("*"),
      Dinero.db("matpakke_items").select("*"),
      Dinero.db("bake_items").select("*"),
      Dinero.db("sides").select("*"),
    ]);
    state.dinners = indexById(dinnersRows);
    state.matpakke = indexById(mpRows);
    state.bake = indexById(bakeRows);
    state.sides = indexById(sideRows);
    libraryLoaded = true;
  }

  // Pure — derives the 👍/👎 button highlight from a persisted net feedback score. A positive
  // net score highlights 👍, negative highlights 👎, zero (or never voted) highlights neither.
  // Used by loadFeedback() below to fix roadmap #10 ("👍/👎 nullstilles visuelt ved omlasting"):
  // the score itself already persisted correctly, only the button highlight was session-only
  // (state.feedbackToggle got reset to {} on every showApp()) — this reconstructs it from the
  // same score the database already has, instead of adding new state to track separately.
  function feedbackToggleFromScore(score) {
    if (score > 0) return "up";
    if (score < 0) return "down";
    return undefined;
  }

  async function loadFeedback() {
    const rows = await Dinero.db("feedback").select("*", { household_id: "eq." + state.uid });
    const byKind = { dinner: {}, matpakke: {}, bakst: {} };
    const toggle = {};
    (rows || []).forEach((r) => {
      (byKind[r.item_kind] || (byKind[r.item_kind] = {}))[r.item_id] = r.score;
      const t = feedbackToggleFromScore(r.score);
      if (t) toggle[r.item_kind + ":" + r.item_id] = t;
    });
    state.feedback = byKind;
    state.feedbackToggle = toggle;
  }

  async function loadInventory() {
    const rows = await Dinero.db("inventory_items").select("*", { household_id: "eq." + state.uid, order: "category.asc,item_name.asc" });
    state.inventory = rows || [];
    state.inventoryNames = state.inventory.map((r) => r.item_name.toLowerCase());
  }

  async function loadWeekSlots() {
    // No week_key filter — loads all three weeks' rows at once so switching the week tab is
    // an instant client-side re-render, not another round trip.
    const rows = await Dinero.db("week_plan_slots").select("*", { household_id: "eq." + state.uid });
    state.weekSlots = (rows || []).sort((a, b) => DAY_LABELS.indexOf(a.day_label) - DAY_LABELS.indexOf(b.day_label));
  }

  function slotFor(dayLabel, slotType, weekKey) {
    return state.weekSlots.find((s) => s.day_label === dayLabel && s.slot_type === slotType && s.week_key === weekKey);
  }

  // ---------- generating the plan a household's never had before ----------

  // Pure: computes the rows for one week's dinner plan without touching the database, so it
  // can be reused both by ensureAllWeeksGenerated() (first-time generation) and
  // regenerateDinnerWeek() (explicit "throw this week away and redo it" from the UI).
  // `excludeIds`, if given, is a set of dinner ids already used in OTHER already-generated
  // weeks — the pool prefers dishes not in that set (falls back to the full pool if that
  // would leave too little to choose from), so the three weeks don't just repeat each other.
  function generateDinnerPlanRows(weekKey, excludeIds) {
    const dayTypes = computeWeekdayTypes(state.household);
    const keywords = allergyKeywords(state.household.allergies);
    const cuisineKw = cuisineKeywords(state.household.cuisine_preferences);
    const fullPool = Object.keys(state.dinners);
    let allergySafePool = filterAllergySafe(fullPool, state.dinners, keywords);
    allergySafePool = filterVegetarian(allergySafePool, state.dinners, state.household.vegetar);
    const chosen = [];
    const rows = [];
    DAY_LABELS.forEach((day) => {
      const type = dayTypes[day];
      if (type === "dinner") {
        let avail = allergySafePool.filter((id) => !chosen.includes(id) && !(excludeIds && excludeIds.has(id)));
        if (!avail.length) avail = allergySafePool.filter((id) => !chosen.includes(id)); // cross-week dedup gave nothing — fall back within this week's own dedup
        if (!avail.length) avail = allergySafePool.length ? allergySafePool : fullPool;
        const id = weightedPick(avail, {}, (i) => state.dinners[i].ingredients, (i) => cuisineMatchCount(state.dinners[i], cuisineKw));
        chosen.push(id);
        rows.push({ household_id: state.uid, week_key: weekKey, day_label: day, slot_type: "dinner", item_id: id, side_id: null });
      } else {
        rows.push({ household_id: state.uid, week_key: weekKey, day_label: day, slot_type: type, item_id: null, side_id: null });
      }
    });
    return { rows, chosen };
  }

  // Explicit, user-triggered redo of ONE week's dinner plan (feedback item 5's "Regenerer …"
  // button). Deletes only that week's dinner/flex/godtlevert rows (never matpakke/bakst,
  // which share the same week_key) and regenerates from current settings/preferences —
  // this is the one place a week's dinner plan is ever thrown away and redone; everywhere
  // else, once a week has rows, they persist until an individual slot is swapped.
  async function regenerateDinnerWeek(weekKey) {
    const excludeIds = new Set(
      state.weekSlots
        .filter((s) => s.week_key !== weekKey && (s.slot_type === "dinner" || s.slot_type === "flex") && s.item_id)
        .map((s) => s.item_id)
    );
    await Dinero.db("week_plan_slots").delete({
      household_id: "eq." + state.uid,
      week_key: "eq." + weekKey,
      slot_type: "in.(dinner,flex,godtlevert)",
    });
    const { rows } = generateDinnerPlanRows(weekKey, excludeIds);
    await Dinero.db("week_plan_slots").upsert(rows, "household_id,week_key,day_label,slot_type");
    await loadWeekSlots();
  }

  // Same idea as regenerateDinnerWeek(), for matpakke/bakst (feature parity requested
  // 2026-08-31: "samme funksjonalitet på matpakkene"). Deletes only that week's matpakke/bakst
  // rows (never dinner/flex/godtlevert, which share the same week_key) and regenerates from
  // current settings — allergies and matpakke_preferences now both feed the pick, see
  // generateMatpakkePlanRows().
  async function regenerateMatpakkeWeek(weekKey) {
    const excludeIds = new Set(
      state.weekSlots
        .filter((s) => s.week_key !== weekKey && (s.slot_type === "matpakke" || s.slot_type === "bakst") && s.item_id)
        .map((s) => s.item_id)
    );
    await Dinero.db("week_plan_slots").delete({
      household_id: "eq." + state.uid,
      week_key: "eq." + weekKey,
      slot_type: "in.(matpakke,bakst)",
    });
    const { rows } = generateMatpakkePlanRows(weekKey, excludeIds);
    await Dinero.db("week_plan_slots").upsert(rows, "household_id,week_key,day_label,slot_type");
    await loadWeekSlots();
  }

  function pickDistinct(pool, n, scoreMap, ingrLookup, prefLookup) {
    const chosen = [];
    let remaining = pool.slice();
    for (let i = 0; i < n; i++) {
      if (!remaining.length) remaining = pool.slice(); // pool smaller than n — allow repeats rather than come up short
      const id = weightedPick(remaining, scoreMap, ingrLookup, prefLookup);
      if (id == null) break;
      chosen.push(id);
      remaining = remaining.filter((x) => x !== id);
    }
    return chosen;
  }

  // Generic version of cuisineMatchCount() for items that don't have a `cuisine` tag
  // (matpakke_items/bake_items) — matches preference keywords against the item's own
  // display name (`nameField`, e.g. "label" or "name") and its ingredient names. Used to
  // give matpakke_preferences the same soft ~1.15x-per-match nudge that cuisine_preferences
  // gives dinners (see weightedPick()'s cuisineLookup param — this fills that same role).
  function textMatchCount(item, keywords, nameField) {
    if (!item || !keywords || !keywords.length) return 0;
    let count = 0;
    const nameLower = (item[nameField] || "").toLowerCase();
    const ingrNames = (item.ingredients || []).map((i) => (i.n || "").toLowerCase());
    keywords.forEach((kw) => {
      if (nameLower && (nameLower.includes(kw) || kw.includes(nameLower))) count++;
      else if (ingrNames.some((n) => n.includes(kw))) count++;
    });
    return count;
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Pure, same purpose as generateDinnerPlanRows() but for the matpakke/bakst slots.
  // `excludeIds` (matpakke_items ids ∪ bake_items ids already used in OTHER already-generated
  // weeks) gets the same "prefer not already used elsewhere, fall back if the pool's too
  // small" treatment.
  //
  // FEATURE PARITY (2026-08-31, "samme funksjonalitet på matpakkene"): previously this ignored
  // both allergies and matpakke_preferences entirely — a real gap, since a household could
  // state an allergy and still get it suggested in a matpakke. Now mirrors generateDinnerPlanRows():
  // a hard allergy filter (via filterAllergySafe(), falling back to the full pool only if the
  // filter would leave nothing to choose from) plus a soft ~1.15x-per-match nudge from
  // matpakke_preferences (via textMatchCount(), the cuisine_preferences equivalent for items
  // that have no `cuisine` tag).
  // FIX (roadmap #3, 2026-09-02): bake day was hardcoded to "Ons" — now reads the household's
  // own choice (`household.bake_day`, a lowercase day code like the existing godtlevert_days
  // convention: man/tir/ons/tor/fre), defaulting to "ons" for households that haven't set one
  // (matches the column's own DB default, so a pre-migration household behaves identically to
  // before). Pure, so it's directly testable.
  function bakeDayLabel(household) {
    const code = ((household && household.bake_day) || "ons").toLowerCase();
    const map = { man: "Man", tir: "Tir", ons: "Ons", tor: "Tor", fre: "Fre" };
    return map[code] || "Ons";
  }

  function generateMatpakkePlanRows(weekKey, excludeIds) {
    const bakeDay = bakeDayLabel(state.household);
    const mpDays = WEEKDAY_LABELS.filter((d) => d !== bakeDay); // the other four weekdays get matpakke
    const keywords = allergyKeywords(state.household.allergies);
    const prefKeywords = cuisineKeywords(state.household.matpakke_preferences);

    const mpFullPool = Object.keys(state.matpakke);
    let mpAllergySafe = filterAllergySafe(mpFullPool, state.matpakke, keywords);
    mpAllergySafe = filterVegetarian(mpAllergySafe, state.matpakke, state.household.vegetar);
    let mpPool = excludeIds && excludeIds.size ? mpAllergySafe.filter((id) => !excludeIds.has(id)) : mpAllergySafe;
    if (mpPool.length < mpDays.length) mpPool = mpAllergySafe; // not enough left to fill every day distinctly — drop the cross-week exclusion but keep allergy/vegetar safety
    if (mpPool.length < mpDays.length) mpPool = mpFullPool; // filters alone left too few — never fully lock a household out (matches filterAllergySafe()'s own fallback philosophy)
    const mpIds = pickDistinct(mpPool, mpDays.length, {}, (i) => state.matpakke[i].ingredients, (i) => textMatchCount(state.matpakke[i], prefKeywords, "label"));

    const bakeFullPool = Object.keys(state.bake);
    let bakeAllergySafe = filterAllergySafe(bakeFullPool, state.bake, keywords);
    bakeAllergySafe = filterVegetarian(bakeAllergySafe, state.bake, state.household.vegetar);
    let bakePool = excludeIds && excludeIds.size ? bakeAllergySafe.filter((id) => !excludeIds.has(id)) : bakeAllergySafe;
    if (!bakePool.length) bakePool = bakeAllergySafe;
    if (!bakePool.length) bakePool = bakeFullPool;
    const bakeId = weightedPick(bakePool, {}, (i) => state.bake[i].ingredients, (i) => textMatchCount(state.bake[i], prefKeywords, "name"));

    const sideFullPool = Object.keys(state.sides);
    let sideAllergySafe = filterAllergySafe(sideFullPool, state.sides, keywords);
    sideAllergySafe = filterVegetarian(sideAllergySafe, state.sides, state.household.vegetar);
    const sideIds = shuffled(sideAllergySafe);
    const rows = [];
    const chosen = mpIds.slice();
    mpDays.forEach((day, i) => {
      rows.push({
        household_id: state.uid, week_key: weekKey, day_label: day, slot_type: "matpakke",
        item_id: mpIds[i] || mpIds[0] || null, side_id: sideIds[i % sideIds.length] || null,
      });
    });
    rows.push({
      household_id: state.uid, week_key: weekKey, day_label: bakeDay, slot_type: "bakst",
      item_id: bakeId, side_id: sideIds[mpDays.length % sideIds.length] || null,
    });
    if (bakeId) chosen.push(bakeId);
    return { rows, chosen };
  }

  // Generates any of the three weeks that don't have rows yet (dinner AND matpakke), in
  // order 'denne' -> 'neste' -> 'neste2', each excluding items already used by the OTHER
  // already-generated weeks where reasonably possible. Weeks that already have rows (from an
  // earlier visit, or an existing household from before this feature) are left completely
  // untouched — never silently regenerated — their items just seed the exclude-set so later
  // weeks in the loop still avoid repeating them.
  async function ensureAllWeeksGenerated() {
    const usedDinnerIds = new Set();
    const usedMatpakkeIds = new Set();
    for (const wk of WEEK_KEYS) {
      const existingDinner = state.weekSlots.filter((s) => s.week_key === wk && (s.slot_type === "dinner" || s.slot_type === "flex") && s.item_id);
      if (existingDinner.length) {
        existingDinner.forEach((s) => usedDinnerIds.add(s.item_id));
      } else {
        const { rows, chosen } = generateDinnerPlanRows(wk, usedDinnerIds);
        await Dinero.db("week_plan_slots").upsert(rows, "household_id,week_key,day_label,slot_type");
        chosen.forEach((id) => { if (id) usedDinnerIds.add(id); });
      }
      if (!state.household.matpakke_enabled) continue;
      const existingMp = state.weekSlots.filter((s) => s.week_key === wk && (s.slot_type === "matpakke" || s.slot_type === "bakst") && s.item_id);
      if (existingMp.length) {
        existingMp.forEach((s) => usedMatpakkeIds.add(s.item_id));
      } else {
        const { rows, chosen } = generateMatpakkePlanRows(wk, usedMatpakkeIds);
        await Dinero.db("week_plan_slots").upsert(rows, "household_id,week_key,day_label,slot_type");
        chosen.forEach((id) => { if (id) usedMatpakkeIds.add(id); });
      }
    }
  }

  // ---------- swap ("Bytt ut" / "⚡ Rask") pools ----------

  function usedDinnerIdsThisWeek(weekKey) {
    return new Set(
      state.weekSlots
        .filter((s) => s.week_key === weekKey && (s.slot_type === "dinner" || s.slot_type === "flex") && s.item_id)
        .map((s) => s.item_id)
    );
  }

  function pickAlternativeDinner(currentId, opts, weekKey) {
    opts = opts || {};
    const used = usedDinnerIdsThisWeek(weekKey);
    const keywords = allergyKeywords(state.household.allergies);
    const cuisineKw = cuisineKeywords(state.household.cuisine_preferences);
    let base = Object.keys(state.dinners).filter((id) => id !== currentId);
    if (opts.fast) base = base.filter((id) => state.dinners[id].time_minutes <= QUICK_MAX_MINUTES);
    let pool = base.filter((id) => !used.has(id));
    if (!pool.length) pool = base;
    pool = filterAllergySafe(pool, state.dinners, keywords);
    pool = filterVegetarian(pool, state.dinners, state.household.vegetar);
    if (!pool.length) pool = base.length ? base : Object.keys(state.dinners).filter((id) => id !== currentId);
    return weightedPick(pool, state.feedback.dinner, (id) => state.dinners[id].ingredients, (id) => cuisineMatchCount(state.dinners[id], cuisineKw));
  }

  // FEATURE PARITY (2026-08-31): "Bytt ut" now respects allergies (hard filter) and
  // matpakke_preferences (soft nudge), same as pickAlternativeDinner() above and
  // generateMatpakkePlanRows() — previously a single manual swap could reintroduce an
  // allergen even though the weekly regenerate now avoids it.
  function pickAlternativeMatpakke(currentId, weekKey) {
    const used = new Set(state.weekSlots.filter((s) => s.week_key === weekKey && s.slot_type === "matpakke" && s.item_id).map((s) => s.item_id));
    const keywords = allergyKeywords(state.household.allergies);
    const prefKeywords = cuisineKeywords(state.household.matpakke_preferences);
    let base = Object.keys(state.matpakke).filter((id) => id !== currentId);
    let pool = base.filter((id) => !used.has(id));
    if (!pool.length) pool = base;
    pool = filterAllergySafe(pool, state.matpakke, keywords);
    pool = filterVegetarian(pool, state.matpakke, state.household.vegetar);
    if (!pool.length) pool = base.length ? base : Object.keys(state.matpakke).filter((id) => id !== currentId);
    return weightedPick(pool, state.feedback.matpakke, (id) => state.matpakke[id].ingredients, (id) => textMatchCount(state.matpakke[id], prefKeywords, "label"));
  }

  function pickAlternativeBake(currentId) {
    const keywords = allergyKeywords(state.household.allergies);
    const prefKeywords = cuisineKeywords(state.household.matpakke_preferences);
    let pool = Object.keys(state.bake).filter((id) => id !== currentId);
    pool = filterAllergySafe(pool, state.bake, keywords);
    pool = filterVegetarian(pool, state.bake, state.household.vegetar);
    if (!pool.length) pool = Object.keys(state.bake).filter((id) => id !== currentId);
    return weightedPick(pool.length ? pool : Object.keys(state.bake), state.feedback.bakst, (id) => state.bake[id].ingredients, (id) => textMatchCount(state.bake[id], prefKeywords, "name"));
  }

  // ---------- feedback (👍/👎) ----------

  async function voteFeedback(itemKind, itemId, val) {
    const key = itemKind + ":" + itemId;
    const prev = state.feedbackToggle[key];
    const next = prev === val ? undefined : val;
    let delta = 0;
    if (prev === "up") delta -= 1;
    if (prev === "down") delta += 1;
    if (next === "up") delta += 1;
    if (next === "down") delta -= 1;
    state.feedbackToggle[key] = next;
    const scoreMap = state.feedback[itemKind] || (state.feedback[itemKind] = {});
    const newScore = (scoreMap[itemId] || 0) + delta;
    scoreMap[itemId] = newScore;
    try {
      await Dinero.db("feedback").upsert(
        [{ household_id: state.uid, item_id: itemId, item_kind: itemKind, score: newScore }],
        "household_id,item_id,item_kind"
      );
    } catch (e) {
      // Roll back local state so the UI doesn't drift from the database on failure.
      scoreMap[itemId] = newScore - delta;
      state.feedbackToggle[key] = prev;
      throw e;
    }
  }

  // ================================================================================
  // ONBOARDING
  // ================================================================================

  function showOnboarding(container, household, opts) {
    opts = opts || {};
    state.household = household;
    state.uid = household.id;
    let children = Array.isArray(household.children) ? household.children.slice() : [];
    if (!children.length) children = [{ name: "", age: "" }];

    function childRowHtml(child, i) {
      return `<div class="child-row" data-child-row="${i}">
        <div style="flex:2;"><input type="text" data-child-name="${i}" placeholder="Navn" value="${esc(child.name || "")}"></div>
        <div style="flex:1;"><input type="number" min="0" max="25" data-child-age="${i}" placeholder="Alder" value="${esc(child.age != null ? child.age : "")}"></div>
        <button type="button" data-child-remove="${i}" title="Fjern">✕</button>
      </div>`;
    }

    // BUG FIX (2026-09-03, broader fix — Sidsel's report): add-child/remove-child used to call
    // the full render() below, which rebuilds the ENTIRE form from the `household` closure
    // variable — that wiped every other field the household had typed in (allergier,
    // vegetar-avkrysning, matpreferanser, GodtLevert-dager, bakedag, antall voksne), not just
    // the children rows, since none of those other fields' current DOM values ever get read
    // back into anything before render() re-derives their HTML from the original, stale
    // `household` object. Confirmed via a real-browser test before this fix (every field but
    // the children ones was wiped by clicking "+ Legg til barn"). Fix: add/remove-child now
    // only rebuilds the `#ob-children` block in place — the rest of the form's DOM, and
    // whatever the household currently has typed into it, is left completely untouched.
    function renderChildrenBlock() {
      document.getElementById("ob-children").innerHTML = children.map(childRowHtml).join("");
      document.querySelectorAll("#ob-children [data-child-remove]").forEach((btn) => {
        btn.onclick = () => {
          syncChildrenFromDom();
          const i = Number(btn.dataset.childRemove);
          children.splice(i, 1);
          if (!children.length) children.push({ name: "", age: "" });
          renderChildrenBlock();
        };
      });
    }

    function dayCheckHtml(code, label) {
      const checked = (household.godtlevert_days || []).includes(code) ? "checked" : "";
      return `<label><input type="checkbox" name="glday" value="${code}" ${checked}> ${label}</label>`;
    }

    function bakeDayOptionsHtml(selected) {
      const opts = [["man", "Mandag"], ["tir", "Tirsdag"], ["ons", "Onsdag"], ["tor", "Torsdag"], ["fre", "Fredag"]];
      return opts.map(([code, label]) => `<option value="${code}" ${code === selected ? "selected" : ""}>${label}</option>`).join("");
    }

    function render() {
      container.innerHTML = `
        <div class="card">
          <h2>Tilpass matpreferanser</h2>
          <p class="hint">${opts.firstTime ? "Noen raske spørsmål før vi setter opp ukeplanen deres — tar under to minutter." : "Endre husstandens innstillinger når som helst."}</p>

          <label for="ob-adults">Antall voksne</label>
          <input id="ob-adults" type="number" min="1" max="10" value="${esc(household.adults || 2)}">

          <label>Barn</label>
          <div id="ob-children">${children.map(childRowHtml).join("")}</div>
          <button type="button" class="add-link-btn" id="ob-add-child">+ Legg til barn</button>

          <label for="ob-dinners">Hvor mange hverdagsmiddager lager dere selv? (1–5)</label>
          <input id="ob-dinners" type="number" min="1" max="5" value="${esc(household.active_dinners_per_week != null ? household.active_dinners_per_week : 5)}">
          <div class="hint">Resten av hverdagene fylles med GodtLevert (om dere bruker det) eller står åpne for pizza/takeout/rester.</div>

          <div class="checkbox-row">
            <input type="checkbox" id="ob-godtlevert" ${household.uses_godtlevert ? "checked" : ""}>
            <label for="ob-godtlevert">Vi bruker GodtLevert eller lignende middagslevering</label>
          </div>
          <div id="ob-godtlevert-days" style="display:${household.uses_godtlevert ? "block" : "none"};">
            <label>Hvilke dager?</label>
            <div class="day-picker">
              ${dayCheckHtml("man", "Man")}${dayCheckHtml("tir", "Tir")}${dayCheckHtml("ons", "Ons")}${dayCheckHtml("tor", "Tor")}${dayCheckHtml("fre", "Fre")}
            </div>
          </div>

          <label for="ob-cuisine">Hva liker dere å spise? (fritekst)</label>
          <textarea class="plain" id="ob-cuisine" placeholder="F.eks. mye asiatisk og italiensk, gjerne litt fisk, ikke for sterkt">${esc(household.cuisine_preferences || "")}</textarea>

          <div class="checkbox-row">
            <input type="checkbox" id="ob-vegetar" ${household.vegetar ? "checked" : ""}>
            <label for="ob-vegetar">Husstanden spiser ikke kjøtt eller fisk (vegetar)</label>
          </div>
          <div class="hint">Dette er et fast filter, ikke bare en preferanse — er denne huket av får dere kun vegetarretter, uansett hva som står i fritekstfeltene over.</div>

          <label for="ob-allergies">Allergier eller annet dere ikke kan/vil spise</label>
          <textarea class="plain" id="ob-allergies" placeholder="F.eks. nøtteallergi, spiser ikke svin — skriv i vanlig tekst">${esc(household.allergies || "")}</textarea>
          <div class="hint">Vi bruker dette til å luke bort retter som inneholder det du skriver — enkel matching, ikke en fasit, så dobbeltsjekk gjerne selv.</div>

          <div class="checkbox-row">
            <input type="checkbox" id="ob-matpakke" ${household.matpakke_enabled !== false ? "checked" : ""}>
            <label for="ob-matpakke">Vi vil ha hjelp med matpakke også</label>
          </div>
          <div id="ob-matpakke-prefs-wrap" style="display:${household.matpakke_enabled !== false ? "block" : "none"};">
            <label for="ob-bakedag">Hvilken dag baker dere?</label>
            <select id="ob-bakedag">${bakeDayOptionsHtml((household.bake_day || "ons").toLowerCase())}</select>
            <label for="ob-matpakke-prefs">Matpakke-preferanser (fritekst)</label>
            <textarea class="plain" id="ob-matpakke-prefs" placeholder="F.eks. brødskiver med variert pålegg, gjerne noe søtt innimellom, ikke myke bananer">${esc(household.matpakke_preferences || "")}</textarea>
          </div>

          <button id="ob-submit">Lagre og fortsett</button>
          <div class="error" id="ob-error"></div>
        </div>`;

      renderChildrenBlock();
      document.getElementById("ob-add-child").onclick = () => {
        syncChildrenFromDom();
        children.push({ name: "", age: "" });
        renderChildrenBlock();
      };
      const glCheckbox = document.getElementById("ob-godtlevert");
      glCheckbox.onchange = () => {
        document.getElementById("ob-godtlevert-days").style.display = glCheckbox.checked ? "block" : "none";
      };
      const mpCheckbox = document.getElementById("ob-matpakke");
      mpCheckbox.onchange = () => {
        document.getElementById("ob-matpakke-prefs-wrap").style.display = mpCheckbox.checked ? "block" : "none";
      };

      document.getElementById("ob-submit").onclick = () => submit();
    }

    function readChildrenFromDom() {
      const out = [];
      container.querySelectorAll("[data-child-row]").forEach((row) => {
        const i = row.dataset.childRow;
        const name = (container.querySelector(`[data-child-name="${i}"]`).value || "").trim();
        const ageRaw = container.querySelector(`[data-child-age="${i}"]`).value;
        if (!name && !ageRaw) return;
        out.push({ name: name, age: ageRaw ? Number(ageRaw) : null });
      });
      return out;
    }

    // Pulls whatever is currently typed into the child name/age inputs back into the
    // `children` array before we re-render (adding/removing a row calls renderChildrenBlock(),
    // which rebuilds the child-rows block from `children` — without this sync step, anything
    // already typed into an existing row would be silently discarded on every add/remove click).
    function syncChildrenFromDom() {
      container.querySelectorAll("[data-child-row]").forEach((row) => {
        const i = Number(row.dataset.childRow);
        if (!children[i]) return;
        const nameEl = container.querySelector(`[data-child-name="${i}"]`);
        const ageEl = container.querySelector(`[data-child-age="${i}"]`);
        children[i] = {
          name: nameEl ? nameEl.value : children[i].name,
          age: ageEl ? ageEl.value : children[i].age,
        };
      });
    }

    async function submit() {
      const errEl = document.getElementById("ob-error");
      errEl.style.display = "none";
      const adults = Math.max(1, Math.min(10, Number(document.getElementById("ob-adults").value) || 1));
      const activeDinners = Math.max(1, Math.min(5, Number(document.getElementById("ob-dinners").value) || 5));
      const usesGodtlevert = document.getElementById("ob-godtlevert").checked;
      const godtlevertDays = usesGodtlevert
        ? Array.from(container.querySelectorAll('input[name="glday"]:checked')).map((el) => el.value)
        : [];
      const patch = {
        adults: adults,
        children: readChildrenFromDom(),
        active_dinners_per_week: activeDinners,
        uses_godtlevert: usesGodtlevert,
        godtlevert_days: godtlevertDays,
        cuisine_preferences: document.getElementById("ob-cuisine").value.trim(),
        vegetar: document.getElementById("ob-vegetar").checked,
        allergies: document.getElementById("ob-allergies").value.trim(),
        matpakke_enabled: document.getElementById("ob-matpakke").checked,
        bake_day: document.getElementById("ob-bakedag").value,
        matpakke_preferences: document.getElementById("ob-matpakke-prefs").value.trim(),
        onboarding_completed: true,
      };
      const btn = document.getElementById("ob-submit");
      btn.disabled = true;
      try {
        const rows = await Dinero.db("households").update(patch, { id: "eq." + household.id });
        const updated = (rows && rows[0]) ? rows[0] : Object.assign({}, household, patch);
        // ADDED (2026-09-07): first-time households only get one extra low-friction step before
        // entering the app — a "check off what you always have" staples screen, so inventory
        // isn't a blank, un-adopted tab from day one. Re-opening settings later (firstTime false)
        // skips straight to onDone as before; that path already has its own way in via the
        // Inventar tab's own "+ Foreslå faste varer" toggle.
        if (opts.firstTime) {
          await renderStaplesStep(updated);
        } else if (typeof opts.onDone === "function") {
          opts.onDone(updated);
        }
      } catch (e) {
        errEl.textContent = errMsg(e);
        errEl.style.display = "block";
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function renderStaplesStep(updatedHousehold) {
      let existingNames = [];
      try {
        const rows = await Dinero.db("inventory_items").select("item_name", { household_id: "eq." + state.uid });
        existingNames = (rows || []).map((r) => r.item_name.toLowerCase());
      } catch (e) {
        // Non-fatal — worst case the checklist just doesn't pre-tick anything already there.
      }
      container.innerHTML = `
        <div class="card">
          <h2>Faste varer</h2>
          <p class="hint">Har dere noen av disse hjemme til vanlig? Huk av det som stemmer — resten kan legges til senere under fanen «Inventar». Dette gjør at handlelisten automatisk vet hva dere allerede har, i stedet for å foreslå at dere kjøper det på nytt.</p>
          <div id="ob-staples-groups">${staplesChecklistHtml(existingNames)}</div>
          <button id="ob-staples-submit">Legg til valgte og fortsett</button>
          <button type="button" class="add-link-btn" id="ob-staples-skip">Hopp over</button>
          <div class="error" id="ob-staples-error"></div>
        </div>`;
      const submitBtn = document.getElementById("ob-staples-submit");
      submitBtn.onclick = async () => {
        submitBtn.disabled = true;
        try {
          await insertSelectedStaples(document.getElementById("ob-staples-groups"));
          if (typeof opts.onDone === "function") opts.onDone(updatedHousehold);
        } catch (e) {
          const errEl2 = document.getElementById("ob-staples-error");
          errEl2.textContent = errMsg(e);
          errEl2.style.display = "block";
          submitBtn.disabled = false;
        }
      };
      document.getElementById("ob-staples-skip").onclick = () => {
        if (typeof opts.onDone === "function") opts.onDone(updatedHousehold);
      };
    }

    render();
  }

  // ================================================================================
  // MAIN APP SHELL
  // ================================================================================

  async function showApp(container, household) {
    state.household = household;
    state.uid = household.id;
    state.openRecipes = new Set();
    state.openLibraryRecipes = new Set();
    state.feedbackToggle = {};
    state.showRecipeForm = false;

    container.innerHTML = `
      <div class="app-topbar">
        <div class="household-name">${esc(household.name || "Min husstand")}</div>
        <div class="app-topbar-actions">
          <a id="app-settings-link">Innstillinger</a>
          <button id="app-logout-btn">Logg ut</button>
        </div>
      </div>
      <div id="app-banner"></div>
      <nav class="tabs" id="app-tabs"></nav>
      <div id="app-main"><div class="hint">Laster …</div></div>
    `;

    document.getElementById("app-logout-btn").onclick = () => { if (window.doLogout) window.doLogout(); };
    document.getElementById("app-settings-link").onclick = () => openSettings();

    let rolled = false;
    try {
      await ensureLibrary();
      await Promise.all([loadFeedback(), loadInventory()]);
      // Must run BEFORE loadWeekSlots(): it rotates week_key labels directly in the database
      // (denne/neste/neste2) when a real calendar week has passed, so the fetch right after
      // picks up the rotated labels rather than stale ones.
      rolled = await rollWeeksForwardIfNeeded();
      await loadWeekSlots();
      await ensureAllWeeksGenerated(); // fills in whatever the rotation just emptied out (or first-ever generation)
      await loadWeekSlots(); // re-fetch so freshly-generated rows (with real ids) are in state
    } catch (e) {
      showBanner("app-banner", "Fikk ikke lastet ukeplanen: " + errMsg(e));
      document.getElementById("app-main").innerHTML = `<div class="hint">Prøv å laste siden på nytt.</div>`;
      return;
    }

    if (rolled) {
      showBanner("app-banner", "Ny uke! «Denne uken» er oppdatert til inneværende uke, og nye forslag er klare lenger fram.");
    }
    renderTabs(container);
  }

  // ---------- calendar week rollover ----------

  // Monday (00:00 local time) of the ISO week containing `d`.
  function mondayOfWeek(d) {
    const date = new Date(d);
    date.setHours(0, 0, 0, 0);
    const day = date.getDay(); // 0=søn .. 6=lør
    const diff = day === 0 ? -6 : 1 - day; // days to walk back to Monday
    date.setDate(date.getDate() + diff);
    return date;
  }

  function isoDateString(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Rotates week_key labels forward by one real calendar week: the now-past "denne" is
  // discarded, "neste" becomes "denne", "uken etter" becomes "neste" — leaving a fresh, empty
  // "uken etter" for ensureAllWeeksGenerated() to fill in afterwards (reusing its existing
  // "generate whatever week_key currently has zero rows" logic, so no new generation code is
  // needed here). Order matters: denne must be cleared out before neste is renamed into it,
  // and neste must be cleared out (by the rename above) before neste2 is renamed into it — the
  // (household_id, week_key, day_label, slot_type) uniqueness constraint would otherwise
  // collide with rows still sitting under the target label.
  async function rotateWeeksOnce() {
    await Dinero.db("week_plan_slots").delete({ household_id: "eq." + state.uid, week_key: "eq.denne" });
    await Dinero.db("week_plan_slots").update({ week_key: "denne" }, { household_id: "eq." + state.uid, week_key: "eq.neste" });
    await Dinero.db("week_plan_slots").update({ week_key: "neste" }, { household_id: "eq." + state.uid, week_key: "eq.neste2" });
  }

  // Checks whether a real calendar week has passed since the household's stored week_anchor
  // (the Monday that "denne uken" currently represents), and rotates the three week buckets
  // forward that many times if so — so "denne uken" always means the household's actual
  // current week, without ever recomputing an already-viewed week's contents mid-week.
  // Returns true if a rotation happened (so the caller can show a one-time "ny uke" banner).
  async function rollWeeksForwardIfNeeded() {
    const todayMonday = isoDateString(mondayOfWeek(new Date()));
    const anchor = state.household.week_anchor;
    if (!anchor) {
      // First time this household is seen under this feature (existing household from before
      // it shipped, or a brand new signup mid-onboarding) — establish the baseline as
      // "right now", deliberately WITHOUT rotating anything, so nobody's current "denne uken"
      // plan changes out from under them the moment this ships.
      await Dinero.db("households").update({ week_anchor: todayMonday }, { id: "eq." + state.uid });
      state.household.week_anchor = todayMonday;
      return false;
    }
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const diffWeeks = Math.floor((new Date(todayMonday) - new Date(anchor)) / msPerWeek);
    if (diffWeeks < 1) return false; // still the same real week — nothing to do
    for (let i = 0; i < diffWeeks; i++) {
      await rotateWeeksOnce();
    }
    await Dinero.db("households").update({ week_anchor: todayMonday }, { id: "eq." + state.uid });
    state.household.week_anchor = todayMonday;
    return true;
  }

  // Reopens the onboarding form pre-filled with current values, in the DEDICATED
  // #onboardingView container (not #appView) so its narrower onboarding-card styling
  // applies correctly — mirrors exactly what index.html's enterApp() does on first login.
  function openSettings() {
    const onboardingEl = document.getElementById("onboardingView");
    const appEl = document.getElementById("appView");
    appEl.style.display = "none";
    onboardingEl.style.display = "block";
    showOnboarding(onboardingEl, state.household, {
      firstTime: false,
      onDone: (updatedHousehold) => {
        onboardingEl.style.display = "none";
        appEl.style.display = "block";
        runAsync(() => showApp(appEl, updatedHousehold));
      },
    });
  }

  function showBanner(elId, msg) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!msg) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="banner-error">${esc(msg)}</div>`;
  }

  function renderTabs(container) {
    const tabs = [
      { id: "middager", label: "Middager" },
    ];
    if (state.household.matpakke_enabled) tabs.push({ id: "matpakke", label: "Matpakke" });
    tabs.push({ id: "handleliste", label: "Handleliste" });
    tabs.push({ id: "inventar", label: "Inventar" });
    tabs.push({ id: "hjelp", label: "Hjelp" });

    if (!tabs.some((t) => t.id === state.activeTab)) state.activeTab = "middager";

    const nav = document.getElementById("app-tabs");
    nav.innerHTML = tabs.map((t) => `<button data-tab="${t.id}" class="${t.id === state.activeTab ? "active" : ""}">${t.label}</button>`).join("");
    nav.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => { state.activeTab = btn.dataset.tab; renderTabs(container); };
    });
    renderActiveTab();
  }

  function renderActiveTab() {
    const main = document.getElementById("app-main");
    showBanner("app-banner", null);
    if (state.activeTab === "middager") return renderMiddager(main);
    if (state.activeTab === "matpakke") return renderMatpakke(main);
    // Handleliste and Inventar are async (they await a DB fetch before rendering) — their
    // returned promise is not awaited here (this function itself is a plain event handler
    // return value), so a rejection would otherwise surface as an unhandled promise rejection
    // instead of a friendly banner. runAsync() below is what prevents that.
    if (state.activeTab === "handleliste") return runAsync(() => renderHandleliste(main));
    if (state.activeTab === "inventar") return runAsync(() => renderInventar(main));
    if (state.activeTab === "hjelp") return renderHjelp(main);
  }

  // ================================================================================
  // HJELP
  // ================================================================================

  // Re-added 2026-08-31 ("Hjelp-fanen fra testversjonen har forsvunnet") — the prototype had
  // one but it was deliberately left out of the first real-backend port. Rewritten (not just
  // copied) to match how the app actually behaves now, and kept deliberately SHORT — she
  // asked explicitly for "ikke for komplisert": only things that genuinely aren't obvious
  // from just looking at the screen, one short paragraph each, no prototype-only caveats
  // (e.g. the old "lagres kun mens siden er åpen" no longer applies — everything is real now).
  function renderHjelp(main) {
    const items = [
      {
        title: "Appen foreslår, du justerer",
        body: "Middager og matpakker ligger klare når du åpner appen. Liker du ikke et forslag, trykk «Bytt ut» — enkelt som det.",
      },
      {
        title: "👍 og 👎 lærer appen smaken din",
        body: "Retter du liker dukker oftere opp igjen ved «Bytt ut». Retter du ikke liker dukker sjeldnere opp — men forsvinner aldri helt, så variasjonen består.",
      },
      {
        title: "Endret du innstillinger? Trykk «Regenerer»",
        body: "Å lagre nye innstillinger (allergier, preferanser, antall middager …) endrer ikke en uke som allerede er planlagt. «Regenerer middagene»/«Regenerer matpakkene» lager nye forslag for den uken basert på det du nettopp lagret.",
      },
      {
        title: "GodtLevert-dagene dine holder seg faste",
        body: "Dagene du har satt opp med GodtLevert blir alltid stående, uansett hvor mange middager du ellers har valgt å lage selv.",
      },
      {
        title: "Handlelisten fylles automatisk — men bare fra middagene",
        body: "Ingrediensene til ukas middager havner på listen av seg selv. Matpakke er annerledes: der må du selv trykke «Legg til» på det du faktisk trenger å kjøpe.",
      },
      {
        title: "Avkrysning betyr «skal kjøpes», ikke «har kjøpt»",
        body: "Varer du allerede har registrert under Inventar er derfor automatisk uavhuket og nedtonet. Du kan alltid overstyre selv.",
      },
      {
        title: "Det du legger inn under Inventar påvirker forslagene også",
        body: "Retter som bruker opp det dere har hjemme dukker litt oftere opp — bare et mildt dytt, ikke en fasit.",
      },
    ];
    main.innerHTML = `
      <div class="subhead">Slik fungerer Dinero</div>
      <div class="hint">Du trenger ikke lese dette for å bruke appen — men noen av valgene under overflaten er ikke helt opplagte bare ved å se på skjermen.</div>
      ${items.map((it) => `
        <div class="help-item">
          <h4>${esc(it.title)}</h4>
          <p>${esc(it.body)}</p>
        </div>`).join("")}
    `;
  }

  // Wraps an async event handler so a rejected promise never becomes an uncaught error —
  // it shows a banner and logs to console instead, matching supabase-lite.js's defensive style.
  function guard(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        console.error(e);
        showBanner("app-banner", errMsg(e));
      }
    };
  }

  // Fires an async function whose promise nobody else awaits/catches (e.g. because it's
  // called from a synchronous event handler or render path) — same defensive purpose as
  // guard(), just for "fire and forget" calls instead of DOM event handlers.
  function runAsync(fn) {
    Promise.resolve().then(fn).catch((e) => {
      console.error(e);
      showBanner("app-banner", errMsg(e));
    });
  }

  // ---------- shared "denne uken / neste uke / uken etter" segmented control ----------
  // Used by both the Middager and Matpakke tabs — one shared state.activeWeek, so switching
  // weeks means the same thing everywhere in the app rather than each tab tracking its own.
  function weekSwitcherHtml() {
    return `<div class="week-switcher" id="week-switcher">
      ${WEEK_KEYS.map((wk) => `<button data-week="${wk}" class="${wk === state.activeWeek ? "active" : ""}">${esc(WEEK_LABELS[wk])}</button>`).join("")}
    </div>`;
  }
  function bindWeekSwitcher(root, rerender) {
    root.querySelectorAll("[data-week]").forEach((btn) => {
      btn.onclick = () => { state.activeWeek = btn.dataset.week; rerender(); };
    });
  }

  // ================================================================================
  // MIDDAGER
  // ================================================================================

  function dishCardHtml(slot, dish, opts) {
    opts = opts || {};
    const key = "dinner:" + dish.id;
    const fb = state.feedbackToggle[key];
    const recipeOpen = state.openRecipes.has(slot.id);
    return `
      <div class="card-title-row">
        <h3>${esc(dish.name)}</h3>
        ${opts.badge ? `<span class="badge">${opts.badge}</span>` : ""}
      </div>
      <div class="tags">
        <span class="badge time">${dish.time_minutes} min</span>
        <span class="badge">${esc(dish.cuisine)}</span>
        ${dish.is_fish ? `<span class="badge fish">Fisk</span>` : ""}
        ${dish.is_veg ? `<span class="badge veg">Vegetar</span>` : ""}
      </div>
      ${recipeOpen ? `<div class="recipe-box">
        <strong>Ingredienser</strong>
        <div class="ingredients">${esc(fmtIngr(dish.ingredients))}</div>
        <strong>Fremgangsmåte</strong>
        ${(dish.steps && dish.steps.length) ? `<ol>${dish.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : `<p>Ingen fremgangsmåte lagt inn ennå.</p>`}
      </div>` : ""}
      <div class="row-actions">
        <button data-swap="${slot.id}">Bytt ut</button>
        <button data-swapfast="${slot.id}" title="Bytt til en av de raskeste rettene som ikke er brukt denne uka">⚡ Rask</button>
        <button data-recipe="${slot.id}" class="recipe-btn ${recipeOpen ? "open" : ""}">${recipeOpen ? "Skjul oppskrift" : "Vis oppskrift"}</button>
        <button data-fb="${dish.id}:up" class="${fb === "up" ? "active-fb" : ""}">👍</button>
        <button data-fb="${dish.id}:down" class="${fb === "down" ? "active-fb" : ""}">👎</button>
        ${opts.removable ? `<button data-flexremove="${slot.id}">Fjern</button>` : ""}
      </div>`;
  }

  function renderMiddager(main) {
    const weekKey = state.activeWeek;
    main.innerHTML = `
      ${weekSwitcherHtml()}
      <div class="hint">👍/👎 og det du har hjemme påvirker hvilke retter "Bytt ut" plukker oftere framover — ikke bare her og nå.</div>
      <div class="row-actions" style="margin-bottom:14px;">
        <button class="small-btn" id="regen-week-btn">Regenerer middagene for «${esc(WEEK_LABELS[weekKey])}»</button>
        <button class="small-btn" id="recipe-toggle-btn">${state.showRecipeForm ? "Skjul oppskrift-skjema" : "+ Legg til oppskrift"}</button>
      </div>
      ${state.showRecipeForm ? recipeFormSectionHtml() : ""}
      <div id="day-list"></div>
    `;
    bindWeekSwitcher(main, () => renderMiddager(main));
    document.getElementById("regen-week-btn").onclick = guard(async () => {
      const label = WEEK_LABELS[weekKey];
      const ok = confirm(`Dette bytter ut ALLE middager for "${label}" med nye forslag, og fjerner eventuelle manuelle bytter du har gjort for den uka. Fortsette?`);
      if (!ok) return;
      await regenerateDinnerWeek(weekKey);
      renderMiddager(main);
    });
    document.getElementById("recipe-toggle-btn").onclick = () => {
      state.showRecipeForm = !state.showRecipeForm;
      renderMiddager(main);
    };
    if (state.showRecipeForm) bindRecipeFormHandlers(main);
    renderDayList();
  }

  // BUG FIX (2026-09-03, found during a proactive audit after Sidsel's onboarding-form report):
  // every day-list action (👍/👎, Bytt ut, ⚡ Rask, + Legg til middag, Fjern, Vis oppskrift)
  // used to call the full renderMiddager(main) above, which rebuilds the ENTIRE Middager tab —
  // including the "+ Legg til oppskrift" form, if it was open. Since that form's typed-but-
  // unsaved fields (#rec-name, #rec-ingredients, ...) are never read back anywhere before that
  // rebuild, a household mid-way through typing a recipe would silently lose everything the
  // moment they also tapped 👍 on a dinner, swapped a dish, or expanded another recipe box —
  // confirmed via a real-browser reproduction before this fix. Fix: those day-list-only actions
  // now call this extracted renderDayList() instead, which only rebuilds `#day-list` — the
  // recipe-form section (and whatever's currently typed into it) is completely untouched by
  // anything that doesn't itself change the recipe-form section or the visible week/tab.
  function renderDayList() {
    const weekKey = state.activeWeek;
    // BUG FIX (live-test regression): must filter by slot_type too, not just day+week — each
    // day/week now has SEPARATE rows for dinner/godtlevert/flex AND matpakke/bakst (they share
    // day_label+week_key but not slot_type). Without this filter, .find() could return a
    // matpakke/bakst row instead of the dinner-ish one whenever a matpakke/bakst row happened
    // to sort earlier in state.weekSlots than the real dinner row for that day — exactly what
    // happened after "Regenerer": that only re-inserts dinner/flex/godtlevert rows (new ids,
    // sorting after the untouched older matpakke/bakst rows for the same day), so the stale
    // matpakke/bakst row got picked instead, rendering as "Fant ikke retten" since its item_id
    // isn't in state.dinners at all.
    const DINNERISH_TYPES = new Set(["dinner", "flex", "godtlevert"]);
    const dinnerAndFlexSlots = DAY_LABELS.map((day) => state.weekSlots.find((s) => s.day_label === day && s.week_key === weekKey && DINNERISH_TYPES.has(s.slot_type))).filter(Boolean);

    const dayList = document.getElementById("day-list");
    if (!dayList) return; // Middager tab isn't the one currently on screen — nothing to do
    dayList.innerHTML = dinnerAndFlexSlots.map((slot) => {
      if (slot.slot_type === "godtlevert") {
        return `<div class="day-row"><div class="day-label">${slot.day_label}</div>
          <div class="dish-card godtlevert"><div class="card-title-row"><h3 class="godtlevert-tag">GodtLevert</h3></div></div></div>`;
      }
      if (slot.slot_type === "flex") {
        if (!slot.item_id) {
          return `<div class="day-row"><div class="day-label">${slot.day_label}</div>
            <div class="dish-card flex">
              <div class="card-title-row"><h3 class="flex-tag">Åpent</h3><span class="badge time">pizza / takeout / rester</span></div>
              <div class="row-actions"><button data-flexadd="${slot.id}">+ Legg til middag</button></div>
            </div></div>`;
        }
        const dish = state.dinners[slot.item_id];
        if (!dish) return `<div class="day-row"><div class="day-label">${slot.day_label}</div><div class="dish-card"><div class="hint">Fant ikke retten.</div></div></div>`;
        return `<div class="day-row"><div class="day-label">${slot.day_label}</div>
          <div class="dish-card">${dishCardHtml(slot, dish, { badge: "Ekstra middag", removable: true })}</div></div>`;
      }
      // slot_type === 'dinner'
      const dish = state.dinners[slot.item_id];
      if (!dish) return `<div class="day-row"><div class="day-label">${slot.day_label}</div><div class="dish-card"><div class="hint">Fant ikke retten — prøv "Bytt ut".</div></div></div>`;
      return `<div class="day-row"><div class="day-label">${slot.day_label}</div><div class="dish-card">${dishCardHtml(slot, dish)}</div></div>`;
    }).join("");

    dayList.querySelectorAll("[data-swap]").forEach((btn) => {
      btn.onclick = guard(async () => { await swapDinnerSlot(Number(btn.dataset.swap), { fast: false }); });
    });
    dayList.querySelectorAll("[data-swapfast]").forEach((btn) => {
      btn.onclick = guard(async () => { await swapDinnerSlot(Number(btn.dataset.swapfast), { fast: true }); });
    });
    dayList.querySelectorAll("[data-flexadd]").forEach((btn) => {
      btn.onclick = guard(async () => { await swapDinnerSlot(Number(btn.dataset.flexadd), { fast: false }); });
    });
    // (weekKey isn't threaded through these dataset-based handlers above — swapDinnerSlot()
    // derives it from the slot itself, see below, so it's always correct regardless of
    // whether the visible week tab changed between render and click.)
    dayList.querySelectorAll("[data-flexremove]").forEach((btn) => {
      btn.onclick = guard(async () => {
        const slot = state.weekSlots.find((s) => s.id === Number(btn.dataset.flexremove));
        await Dinero.db("week_plan_slots").update({ item_id: null, updated_at: new Date().toISOString() }, { id: "eq." + slot.id });
        slot.item_id = null;
        renderDayList();
      });
    });
    dayList.querySelectorAll("[data-recipe]").forEach((btn) => {
      btn.onclick = () => {
        const id = Number(btn.dataset.recipe);
        if (state.openRecipes.has(id)) state.openRecipes.delete(id); else state.openRecipes.add(id);
        renderDayList();
      };
    });
    dayList.querySelectorAll("[data-fb]").forEach((btn) => {
      btn.onclick = guard(async () => {
        const [dishId, val] = btn.dataset.fb.split(":");
        await voteFeedback("dinner", dishId, val);
        renderDayList();
      });
    });
  }

  async function swapDinnerSlot(slotId, opts) {
    const slot = state.weekSlots.find((s) => s.id === slotId);
    if (!slot) return;
    const newId = pickAlternativeDinner(slot.item_id, opts, slot.week_key);
    if (newId == null) return;
    await Dinero.db("week_plan_slots").update({ item_id: newId, updated_at: new Date().toISOString() }, { id: "eq." + slot.id });
    slot.item_id = newId;
    renderDayList(); // day-list-only update — see renderDayList()'s own comment for why not renderMiddager()
  }

  // ================================================================================
  // OPPSKRIFTER — roadmap #1 ("Legg til egne oppskrifter", 2026-08-31): a self-serve form,
  // embedded as a toggleable section inside Middager (not its own tab) rather than inserting
  // into a database every household reads from — a recipe added here is private to the
  // household that added it. The `dinners` table's SELECT policy restricts what a household
  // can read to seed dishes (created_by is null) plus rows it created itself (see
  // migration_005_oppskrifter_lokalt.sql), so this is enforced at the database level, not just
  // hidden in the UI. Deliberately scoped to dinners only (matching the roadmap item's own
  // wording), not matpakke/bake items.
  // ================================================================================

  // Turns a dish name into a URL/id-safe slug: lowercases, folds æøå, strips anything that
  // isn't a-z/0-9 down to single hyphens. Always paired with a random suffix (below) since
  // `dinners.id` is a single shared-table primary key — two households could otherwise pick
  // the exact same slug for two different dishes (e.g. both naming something "Fiskegryte").
  function slugifyName(name) {
    const foldMap = { æ: "ae", ø: "o", å: "a", Æ: "Ae", Ø: "O", Å: "A" };
    let s = String(name).replace(/[æøåÆØÅ]/g, (ch) => foldMap[ch] || ch).toLowerCase().trim();
    s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s || "oppskrift";
  }

  // Builds a new, collision-checked id for a `dinners` row (checked against the currently
  // loaded library in state — a tiny residual race with another household inserting the exact
  // same id in the same instant is possible but harmless: the DB's primary key just rejects it
  // and the household sees a normal error, same as any other insert conflict).
  function makeDinnerId(name) {
    const base = slugifyName(name);
    for (let i = 0; i < 5; i++) {
      const candidate = `${base}-${Math.random().toString(36).slice(2, 7)}`;
      if (!state.dinners[candidate]) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  // Parses one free-typed ingredient line into the {a: amount, n: name} shape the rest of the
  // app already expects (see fmtIngr(), the allergy filter, cuisine/preference matching).
  // Heuristic, not a real parser: a leading number (optionally with a unit word) is taken as
  // the amount, the rest is the name; a line with no leading number (e.g. "salt") gets amount "".
  function parseIngredientLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^([\d.,]+\s*[a-zA-ZæøåÆØÅ]*)\s+(.+)$/);
    if (m) return { a: m[1].trim(), n: m[2].trim() };
    return { a: "", n: trimmed };
  }

  function libraryDishCardHtml(dish) {
    const open = state.openLibraryRecipes.has(dish.id);
    return `
      <div class="dish-card">
        <div class="card-title-row"><h3>${esc(dish.name)}</h3></div>
        <div class="tags">
          <span class="badge time">${dish.time_minutes} min</span>
          <span class="badge">${esc(dish.cuisine)}</span>
          ${dish.is_fish ? `<span class="badge fish">Fisk</span>` : ""}
          ${dish.is_veg ? `<span class="badge veg">Vegetar</span>` : ""}
        </div>
        ${open ? `<div class="recipe-box">
          <strong>Ingredienser</strong>
          <div class="ingredients">${esc(fmtIngr(dish.ingredients))}</div>
          <strong>Fremgangsmåte</strong>
          ${(dish.steps && dish.steps.length) ? `<ol>${dish.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : `<p>Ingen fremgangsmåte lagt inn.</p>`}
        </div>` : ""}
        <div class="row-actions">
          <button data-lib-recipe="${esc(dish.id)}" class="recipe-btn ${open ? "open" : ""}">${open ? "Skjul oppskrift" : "Vis oppskrift"}</button>
        </div>
      </div>`;
  }

  // Pure — the "Deres oppskrifter" list-or-empty-hint markup, extracted so it can be
  // re-rendered on its own (see renderOwnRecipesList() below).
  function ownRecipesListHtml() {
    const ownRecipes = Object.values(state.dinners)
      .filter((d) => d.created_by === state.uid)
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return ownRecipes.length
      ? `<div class="lib-list" id="own-recipes">${ownRecipes.map((d) => libraryDishCardHtml(d)).join("")}</div>`
      : `<div class="hint">Dere har ikke lagt til noen oppskrifter ennå.</div>`;
  }

  // BUG FIX (2026-09-03, same audit as the day-list fix above): expanding/collapsing an
  // EXISTING recipe's "Vis oppskrift" box in the "Deres oppskrifter" list used to call the
  // full renderMiddager(main), which would also wipe whatever was currently typed into the
  // "Legg til oppskrift" ADD form above it (name/time/ingredients/...) even though that toggle
  // has nothing to do with the add-form. Fix: only rebuild the `#own-recipes-wrap` list itself.
  function renderOwnRecipesList() {
    const wrap = document.getElementById("own-recipes-wrap");
    if (!wrap) return;
    wrap.innerHTML = ownRecipesListHtml();
    wrap.querySelectorAll("[data-lib-recipe]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.libRecipe;
        if (state.openLibraryRecipes.has(id)) state.openLibraryRecipes.delete(id); else state.openLibraryRecipes.add(id);
        renderOwnRecipesList();
      };
    });
  }

  // Builds the "Legg til oppskrift" form + "Deres oppskrifter" list as an HTML string, meant to
  // be spliced into Middager's own main.innerHTML template (see renderMiddager above) — not a
  // separate tab/render target. bindRecipeFormHandlers() below wires up its interactive bits
  // once that combined HTML is in the DOM.
  function recipeFormSectionHtml() {
    const cuisineOptions = Array.from(new Set(Object.values(state.dinners).map((d) => d.cuisine).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, "no"))
      .map((c) => `<option value="${esc(c)}"></option>`).join("");

    return `
      <div class="subhead">Legg til oppskrift</div>
      <div class="hint">Oppskriften blir lagt til lokalt hos dere — ikke delt med andre husstander.</div>
      <div id="recipe-form-error"></div>
      <label for="rec-name">Navn</label>
      <input type="text" id="rec-name" placeholder="F.eks. Laksepasta med sitron">
      <div class="field-row">
        <div>
          <label for="rec-time">Tid (minutter)</label>
          <input type="number" id="rec-time" min="1" max="240" placeholder="30">
        </div>
        <div>
          <label for="rec-cuisine">Kjøkken</label>
          <input type="text" id="rec-cuisine" list="rec-cuisine-list" placeholder="F.eks. Italiensk">
          <datalist id="rec-cuisine-list">${cuisineOptions}</datalist>
        </div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="rec-fish"><label for="rec-fish" style="margin:0;">Fisk</label></div>
      <div class="checkbox-row"><input type="checkbox" id="rec-veg"><label for="rec-veg" style="margin:0;">Vegetar</label></div>
      <label for="rec-ingredients">Ingredienser (én per linje)</label>
      <textarea class="plain" id="rec-ingredients" placeholder="600 g laks&#10;2 dl rømme&#10;1 sitron"></textarea>
      <div class="hint">Skriv mengde og navn per linje, f.eks. «600 g laks». Uten mengde holder det med bare navnet, f.eks. «salt».</div>
      <label for="rec-steps">Fremgangsmåte (ett steg per linje)</label>
      <textarea class="plain" id="rec-steps" placeholder="Kok pasta etter anvisning.&#10;Stek laksen i smør.&#10;Bland alt sammen."></textarea>
      <button id="rec-submit">Legg til oppskrift</button>

      <div class="subhead">Deres oppskrifter</div>
      <div id="own-recipes-wrap">${ownRecipesListHtml()}</div>
    `;
  }

  // Wires up the form + list rendered by recipeFormSectionHtml() above, once it's in the DOM as
  // part of Middager. Called from renderMiddager() right after setting main.innerHTML, only when
  // state.showRecipeForm is true (i.e. only when that markup actually exists to bind to).
  function bindRecipeFormHandlers(main) {
    function showFormError(msg) {
      const el = document.getElementById("recipe-form-error");
      if (!el) return;
      el.innerHTML = msg ? `<div class="banner-error">${esc(msg)}</div>` : "";
    }

    document.getElementById("own-recipes-wrap").querySelectorAll("[data-lib-recipe]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.libRecipe;
        if (state.openLibraryRecipes.has(id)) state.openLibraryRecipes.delete(id); else state.openLibraryRecipes.add(id);
        renderOwnRecipesList();
      };
    });

    document.getElementById("rec-submit").onclick = guard(async () => {
      showFormError("");
      const name = document.getElementById("rec-name").value.trim();
      const timeVal = Number(document.getElementById("rec-time").value);
      const cuisine = document.getElementById("rec-cuisine").value.trim() || "Annet";
      const isFish = document.getElementById("rec-fish").checked;
      const isVeg = document.getElementById("rec-veg").checked;
      const ingredientsRaw = document.getElementById("rec-ingredients").value;
      const stepsRaw = document.getElementById("rec-steps").value;

      if (!name) { showFormError("Skriv et navn på retten."); return; }
      if (!timeVal || timeVal <= 0) { showFormError("Skriv hvor mange minutter retten tar."); return; }

      const ingredients = ingredientsRaw.split("\n").map(parseIngredientLine).filter(Boolean);
      const steps = stepsRaw.split("\n").map((s) => s.trim()).filter(Boolean);
      const id = makeDinnerId(name);

      const rows = await Dinero.db("dinners").insert([{
        id, name, time_minutes: Math.round(timeVal), cuisine,
        is_fish: isFish, is_veg: isVeg, ingredients, steps, created_by: state.uid,
      }]);
      const newDish = rows && rows[0];
      if (newDish) state.dinners[newDish.id] = newDish;
      renderMiddager(main);
    });
  }

  // ================================================================================
  // MATPAKKE
  // ================================================================================

  // Pure — builds the day-row list for the Matpakke table, marking whichever weekday is the
  // household's chosen bake day (roadmap #3). Extracted as its own function so it's directly
  // testable without a DOM.
  function matpakkeRowsForBakeDay(bakeDay) {
    return WEEKDAY_LABELS.map((d) => ({ day: d, label: d, bake: d === bakeDay }));
  }

  function renderMatpakke(main) {
    const weekKey = state.activeWeek;
    main.innerHTML = `
      ${weekSwitcherHtml()}
      <div class="subhead">Matpakker (Man–Fre) — ${esc(WEEK_LABELS[weekKey])}</div>
      <div class="hint">👍/👎 påvirker hvilke matpakker "Bytt ut" plukker oftere framover — og allergier/preferanser fra innstillingene dine påvirker alle forslagene.</div>
      <div class="row-actions" style="margin-bottom:14px;">
        <button class="small-btn" id="regen-mp-btn">Regenerer matpakkene for «${esc(WEEK_LABELS[weekKey])}»</button>
      </div>
      <div style="overflow-x:auto;">
        <table class="matpakke">
          <thead><tr><th>Dag</th><th>Matpakke</th><th>Tilbehør</th><th>Handleliste</th></tr></thead>
          <tbody id="mp-body"></tbody>
        </table>
      </div>`;
    bindWeekSwitcher(main, () => renderMatpakke(main));
    document.getElementById("regen-mp-btn").onclick = guard(async () => {
      const label = WEEK_LABELS[weekKey];
      const ok = confirm(`Dette bytter ut ALLE matpakker og bakst for "${label}" med nye forslag, og fjerner eventuelle manuelle bytter du har gjort for den uka. Fortsette?`);
      if (!ok) return;
      await regenerateMatpakkeWeek(weekKey);
      renderMatpakke(main);
    });
    renderMatpakkeBody();
  }

  // Rebuilds only #mp-body (the day-row table body), not the whole Matpakke tab — same "scoped
  // re-render" pattern as renderDayList() under Middager (see that function's comment for the
  // bug class this avoids). All row-level actions below (swap, 👍/👎, legg-til-handleliste, and
  // the "Vis oppskrift" toggle) call this instead of the full renderMatpakke(main), so none of
  // them has to rebuild the week-switcher/regen-button shell above the table.
  function renderMatpakkeBody() {
    const weekKey = state.activeWeek;
    const rows = matpakkeRowsForBakeDay(bakeDayLabel(state.household));
    const body = document.getElementById("mp-body");
    if (!body) return; // Matpakke tab isn't the one currently on screen — nothing to do
    body.innerHTML = rows.map((r) => {
      const slot = slotFor(r.day, r.bake ? "bakst" : "matpakke", weekKey);
      if (!slot) return `<tr><td>${r.label}</td><td colspan="3" class="hint">Ikke satt opp ennå.</td></tr>`;
      const side = slot.side_id ? state.sides[slot.side_id] : null;
      const sideText = side ? esc((side.amount ? side.amount + " " : "") + side.item_name) : "—";
      if (r.bake) {
        const item = state.bake[slot.item_id];
        const fb = state.feedbackToggle["bakst:" + slot.item_id];
        return `<tr><td>${r.label}</td>
          <td><div class="bake-cell"><span>${item ? esc(item.name) : "—"}</span>
            <div style="display:flex; gap:6px; align-items:center;">
              <button class="small-btn ${fb === "up" ? "active-fb" : ""}" data-bakefb="up" data-slot="${slot.id}">👍</button>
              <button class="small-btn ${fb === "down" ? "active-fb" : ""}" data-bakefb="down" data-slot="${slot.id}">👎</button>
              <button class="small-btn" data-swapbake="${slot.id}">Bytt</button>
            </div></div></td>
          <td>${sideText}</td>
          <td><button class="small-btn" data-addrow="${slot.id}" data-kind="bake">Legg til</button></td></tr>`;
      }
      const item = state.matpakke[slot.item_id];
      const fb = state.feedbackToggle["matpakke:" + slot.item_id];
      // "Vis oppskrift" reuses state.openRecipes (slot-id-keyed, already used by the Middager
      // day-list dinner cards) rather than a new set — slot ids are unique across the whole
      // week_plan_slots table regardless of slot_type, so there's no collision risk.
      const recipeOpen = state.openRecipes.has(slot.id);
      const hasSteps = !!(item && item.steps && item.steps.length);
      const recipeRow = recipeOpen ? `<tr class="recipe-row"><td colspan="4"><div class="recipe-box">
          <strong>Ingredienser</strong>
          <div class="ingredients">${esc(fmtIngr(item ? item.ingredients : []))}</div>
          ${hasSteps ? `<strong>Fremgangsmåte</strong><ol>${item.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
        </div></td></tr>` : "";
      return `<tr><td>${r.label}</td>
        <td><div class="bake-cell"><span>${item ? esc(item.label) : "—"}</span>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="small-btn ${fb === "up" ? "active-fb" : ""}" data-mpfb="up" data-slot="${slot.id}">👍</button>
            <button class="small-btn ${fb === "down" ? "active-fb" : ""}" data-mpfb="down" data-slot="${slot.id}">👎</button>
            <button class="small-btn" data-swapmp="${slot.id}">Bytt ut</button>
            <button class="small-btn recipe-btn ${recipeOpen ? "open" : ""}" data-recipe="${slot.id}">${recipeOpen ? "Skjul oppskrift" : "Vis oppskrift"}</button>
          </div></div></td>
        <td>${sideText}</td>
        <td><button class="small-btn" data-addrow="${slot.id}" data-kind="matpakke">Legg til</button></td></tr>${recipeRow}`;
    }).join("");

    body.querySelectorAll("[data-swapmp]").forEach((btn) => {
      btn.onclick = guard(async () => {
        const slot = state.weekSlots.find((s) => s.id === Number(btn.dataset.swapmp));
        const newId = pickAlternativeMatpakke(slot.item_id, slot.week_key);
        if (newId == null) return; // pool exhausted (very small library) — leave as-is rather than clearing it
        await Dinero.db("week_plan_slots").update({ item_id: newId, updated_at: new Date().toISOString() }, { id: "eq." + slot.id });
        slot.item_id = newId;
        renderMatpakkeBody();
      });
    });
    body.querySelectorAll("[data-swapbake]").forEach((btn) => {
      btn.onclick = guard(async () => {
        const slot = state.weekSlots.find((s) => s.id === Number(btn.dataset.swapbake));
        const newId = pickAlternativeBake(slot.item_id);
        if (newId == null) return; // pool exhausted (very small library) — leave as-is rather than clearing it
        await Dinero.db("week_plan_slots").update({ item_id: newId, updated_at: new Date().toISOString() }, { id: "eq." + slot.id });
        slot.item_id = newId;
        renderMatpakkeBody();
      });
    });
    body.querySelectorAll("[data-mpfb]").forEach((btn) => {
      btn.onclick = guard(async () => {
        const slot = state.weekSlots.find((s) => s.id === Number(btn.dataset.slot));
        await voteFeedback("matpakke", slot.item_id, btn.dataset.mpfb);
        renderMatpakkeBody();
      });
    });
    body.querySelectorAll("[data-bakefb]").forEach((btn) => {
      btn.onclick = guard(async () => {
        const slot = state.weekSlots.find((s) => s.id === Number(btn.dataset.slot));
        await voteFeedback("bakst", slot.item_id, btn.dataset.bakefb);
        renderMatpakkeBody();
      });
    });
    body.querySelectorAll("[data-recipe]").forEach((btn) => {
      btn.onclick = () => {
        const id = Number(btn.dataset.recipe);
        if (state.openRecipes.has(id)) state.openRecipes.delete(id); else state.openRecipes.add(id);
        renderMatpakkeBody();
      };
    });
    body.querySelectorAll("[data-addrow]").forEach((btn) => {
      btn.onclick = guard(async () => {
        const slot = state.weekSlots.find((s) => s.id === Number(btn.dataset.addrow));
        const source = btn.dataset.kind === "bake" ? state.bake[slot.item_id] : state.matpakke[slot.item_id];
        const side = slot.side_id ? state.sides[slot.side_id] : null;
        const items = (source ? source.ingredients : []).slice();
        if (side) items.push({ a: side.amount, n: side.item_name });
        await addManualShoppingItems(items);
        btn.textContent = "✓ Lagt til";
        btn.classList.add("added");
        setTimeout(() => { btn.textContent = "Legg til"; btn.classList.remove("added"); }, 1500);
      });
    });
  }

  // ================================================================================
  // HANDLELISTE
  // ================================================================================

  // Ingredients from this week's dinner + flex-dinner slots, merged/deduped by name —
  // matpakke ingredients are NOT included here, matching the prototype ("Handlelisten
  // fylles automatisk fra middagene — ikke fra matpakke").
  function currentDinnerIngredients() {
    // Deliberately hardcoded to week_key 'denne' regardless of state.activeWeek (which week
    // tab is being browsed on the Middager screen) — you shop for the real current week, not
    // whichever week you happen to be previewing/editing.
    const byName = new Map();
    state.weekSlots
      .filter((s) => s.week_key === "denne" && (s.slot_type === "dinner" || s.slot_type === "flex") && s.item_id)
      .forEach((s) => {
        const dish = state.dinners[s.item_id];
        if (!dish) return;
        (dish.ingredients || []).forEach((i) => {
          if (!byName.has(i.n)) byName.set(i.n, []);
          byName.get(i.n).push(i.a);
        });
      });
    return Array.from(byName.entries()).map(([n, amounts]) => ({ name: n, amounts: amounts.filter(Boolean) }));
  }

  // Reconciles the persisted, is_manual=false rows in shopping_list_items with this
  // week's actual dinner ingredients: inserts new ones, refreshes amounts on existing
  // ones, and removes auto rows for ingredients no longer needed (e.g. after a swap).
  // Manually-added rows (is_manual=true) are never touched here.
  async function syncAutoShoppingItems() {
    const current = currentDinnerIngredients();
    const existing = await Dinero.db("shopping_list_items").select("*", { household_id: "eq." + state.uid, is_manual: "eq.false" });
    const existingByName = new Map((existing || []).map((r) => [r.ingredient_name.toLowerCase().trim(), r]));
    const toInsert = [];
    current.forEach((ing) => {
      const key = ing.name.toLowerCase().trim();
      const amountText = ing.amounts.join(" + ");
      const row = existingByName.get(key);
      if (row) {
        existingByName.delete(key);
        if (row.amount !== amountText) {
          Dinero.db("shopping_list_items").update({ amount: amountText }, { id: "eq." + row.id }).catch(() => {});
          row.amount = amountText;
        }
      } else {
        toInsert.push({ household_id: state.uid, ingredient_name: ing.name, amount: amountText, checked: !haveAtHome(ing.name), is_manual: false });
      }
    });
    const toDelete = Array.from(existingByName.values()); // no longer part of any dinner this week
    const ops = [];
    if (toInsert.length) ops.push(Dinero.db("shopping_list_items").insert(toInsert));
    toDelete.forEach((row) => ops.push(Dinero.db("shopping_list_items").delete({ id: "eq." + row.id })));
    await Promise.all(ops);
  }

  async function addManualShoppingItems(items) {
    const existing = await Dinero.db("shopping_list_items").select("*", { household_id: "eq." + state.uid });
    const byName = new Map((existing || []).map((r) => [r.ingredient_name.toLowerCase().trim(), r]));
    const ops = [];
    items.forEach((i) => {
      const key = (i.n || "").toLowerCase().trim();
      if (!key) return;
      const row = byName.get(key);
      if (row) {
        // Already on the list (auto or manual) — just make sure it's checked, since you
        // asked to buy it.
        if (!row.checked) ops.push(Dinero.db("shopping_list_items").update({ checked: true }, { id: "eq." + row.id }));
      } else {
        ops.push(Dinero.db("shopping_list_items").insert([{ household_id: state.uid, ingredient_name: i.n, amount: i.a || "", checked: true, is_manual: true }]));
      }
    });
    await Promise.all(ops);
    // Awaited (not fire-and-forget) so a rejection here is caught by whichever guard()-wrapped
    // click handler called addManualShoppingItems(), instead of becoming an unhandled rejection.
    if (state.activeTab === "handleliste") await renderHandleliste(document.getElementById("app-main"));
  }

  async function renderHandleliste(main) {
    main.innerHTML = `
      <div class="add-item-row">
        <input type="text" id="shop-extra-input" placeholder="Legg til noe selv, f.eks. brød, melk, pålegg …">
        <button id="shop-extra-add">Legg til</button>
      </div>
      <div class="hint" style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
        <span>Handlet ferdig? Nullstill det du har lagt til selv og avkrysningene, så starter listen frisk til neste tur.</span>
        <button class="small-btn" id="shop-reset">Nullstill</button>
      </div>
      <div class="hint" style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
        <span>Klar for butikken? Få det du har huket av som en enkel liste du kan kopiere.</span>
        <button class="small-btn" id="shop-build">Lag liste</button>
      </div>
      <div id="shop-store-box"></div>
      <ul class="shoplist" id="shop-list"><li class="hint">Laster …</li></ul>
    `;
    try {
      await syncAutoShoppingItems();
    } catch (e) {
      showBanner("app-banner", "Fikk ikke synkronisert handlelisten: " + errMsg(e));
    }
    await refreshShopList();

    document.getElementById("shop-extra-add").onclick = guard(async () => {
      const input = document.getElementById("shop-extra-input");
      const val = input.value.trim();
      if (!val) return;
      await addManualShoppingItems([{ a: "", n: val }]);
      input.value = "";
    });
    document.getElementById("shop-extra-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("shop-extra-add").click();
    });
    document.getElementById("shop-reset").onclick = guard(async () => {
      const rows = await Dinero.db("shopping_list_items").select("*", { household_id: "eq." + state.uid });
      const manual = (rows || []).filter((r) => r.is_manual);
      const auto = (rows || []).filter((r) => !r.is_manual);
      await Promise.all([
        ...manual.map((r) => Dinero.db("shopping_list_items").delete({ id: "eq." + r.id })),
        ...auto.map((r) => Dinero.db("shopping_list_items").update({ checked: false }, { id: "eq." + r.id })),
      ]);
      await refreshShopList();
    });
    document.getElementById("shop-build").onclick = () => {
      shopStoreListOpen = !shopStoreListOpen;
      renderShopStoreBox(lastShopRows || []);
    };
  }

  let shopStoreListOpen = false;
  let lastShopRows = [];

  async function refreshShopList() {
    const rows = await Dinero.db("shopping_list_items").select("*", { household_id: "eq." + state.uid, order: "is_manual.asc,ingredient_name.asc" });
    lastShopRows = rows || [];
    const list = document.getElementById("shop-list");
    if (!lastShopRows.length) {
      list.innerHTML = `<li class="hint">Handlelisten er tom. Den fylles automatisk fra ukens middager.</li>`;
    } else {
      list.innerHTML = lastShopRows.map((row) => {
        // FIX (2026-09-07): used to be `!row.is_manual && haveAtHome(...)` — manual rows never
        // got the "har hjemme"/dimmed treatment even after being added to inventory via the new
        // "Fast vare, har alltid hjemme" button below, which would've made that button look like
        // it did nothing. Now consistent for every row, auto or manual.
        const have = haveAtHome(row.ingredient_name);
        return `<li class="${row.checked ? "" : "have"}">
          <input type="checkbox" ${row.checked ? "checked" : ""} data-shop-check="${row.id}">
          <span>${row.amount ? esc(row.amount) + " " : ""}${esc(row.ingredient_name)}</span>
          ${have
            ? '<span class="have-tag">har hjemme</span>'
            : `<button class="staple-btn" data-shop-staple="${row.id}" title="Legg denne varen til i inventaret">Fast vare, har alltid hjemme</button>`}
          ${row.is_manual ? `<button class="remove" data-shop-remove="${row.id}">✕</button>` : ""}
        </li>`;
      }).join("");
    }
    list.querySelectorAll("[data-shop-check]").forEach((cb) => {
      cb.onchange = guard(async () => {
        const id = Number(cb.dataset.shopCheck);
        await Dinero.db("shopping_list_items").update({ checked: cb.checked }, { id: "eq." + id });
        const row = lastShopRows.find((r) => r.id === id);
        if (row) row.checked = cb.checked;
        await refreshShopList();
      });
    });
    // ADDED (2026-09-07, approved wording "Fast vare, har alltid hjemme"): a one-click way to
    // mark a shopping-list item as something the household always has, without navigating to
    // the separate Inventar tab. Defaults to category "Annet" — a shopping-list row carries no
    // category info to seed it with, and "Annet" is freely re-categorizable later from Inventar.
    list.querySelectorAll("[data-shop-staple]").forEach((btn) => {
      btn.onclick = guard(async () => {
        const id = Number(btn.dataset.shopStaple);
        const row = lastShopRows.find((r) => r.id === id);
        if (!row) return;
        await Dinero.db("inventory_items").insert([{ household_id: state.uid, category: "Annet", item_name: row.ingredient_name }]);
        await loadInventory();
        await refreshShopList();
      });
    });
    list.querySelectorAll("[data-shop-remove]").forEach((btn) => {
      btn.onclick = guard(async () => {
        const id = Number(btn.dataset.shopRemove);
        const row = lastShopRows.find((r) => r.id === id);
        // If this ingredient is still needed by a current dinner, don't delete it outright —
        // just demote it to an auto-tracked row so it keeps showing (without the remove button).
        const stillNeeded = row && currentDinnerIngredients().some((i) => i.name.toLowerCase().trim() === row.ingredient_name.toLowerCase().trim());
        if (stillNeeded) {
          await Dinero.db("shopping_list_items").update({ is_manual: false }, { id: "eq." + id });
        } else {
          await Dinero.db("shopping_list_items").delete({ id: "eq." + id });
        }
        await refreshShopList();
      });
    });
    renderShopStoreBox(lastShopRows);
  }

  function renderShopStoreBox(rows) {
    const box = document.getElementById("shop-store-box");
    if (!box) return;
    if (!shopStoreListOpen) { box.innerHTML = ""; return; }
    const checkedRows = rows.filter((r) => r.checked);
    const text = checkedRows.length
      ? checkedRows.map((r) => "• " + (r.amount ? r.amount + " " : "") + r.ingredient_name).join("\n")
      : "Ingenting huket av for kjøp akkurat nå.";
    box.innerHTML = `
      <div class="help-item" style="margin-bottom:12px;">
        <textarea class="plain" readonly style="min-height:120px;">${esc(text)}</textarea>
        <div class="row-actions">
          <button id="shop-copy">Kopier</button>
          <span id="shop-copy-status" class="hint" style="margin:0;"></span>
        </div>
      </div>`;
    document.getElementById("shop-copy").onclick = async () => {
      const status = document.getElementById("shop-copy-status");
      try {
        await navigator.clipboard.writeText(text);
        status.textContent = "Kopiert!";
      } catch (e) {
        status.textContent = "Fikk ikke tilgang til utklippstavlen — merk teksten over og kopier manuelt.";
      }
    };
  }

  // ================================================================================
  // INVENTAR
  // ================================================================================

  const INVENTORY_CATEGORY_SUGGESTIONS = ["Fryser", "Kjøleskap", "Skap — tørrvarer", "Skap — sauser og hermetikk", "Annet"];

  // ADDED (2026-09-07, "hva kan vi gjøre for å øke bruken av inventardelen"): a curated list of
  // common Norwegian pantry staples, used by two entry points that share this same data and the
  // same "check off what you always have" flow — the one-time first-time-onboarding step
  // (showOnboarding's renderStaplesStep) and the "+ Foreslå faste varer" quick-add inside the
  // Inventar tab itself (renderInventar below), for households that skipped/finished onboarding
  // long ago. Neither ever forces anything in — everything starts unchecked (already-present
  // items come pre-checked+disabled) and both are one click away from "Hopp over"/closing.
  const STAPLE_SUGGESTIONS = [
    { category: "Skap — tørrvarer", items: ["Salt", "Pepper", "Sukker", "Mel", "Ris", "Pasta", "Havregryn", "Matolje"] },
    { category: "Skap — sauser og hermetikk", items: ["Ketchup", "Sennep", "Hermetiske tomater", "Buljong"] },
    { category: "Kjøleskap", items: ["Smør", "Melk"] },
    { category: "Fryser", items: ["Brød"] },
  ];

  // Renders the checkbox grid (grouped, reusing the .inv-group/.day-picker styling that's
  // already on the page for onboarding's day-picker) — items already in inventory (by
  // case-insensitive name match) come pre-checked and disabled, so re-opening this never
  // suggests adding a duplicate.
  function staplesChecklistHtml(alreadyHaveLower) {
    return STAPLE_SUGGESTIONS.map((group) => `
      <div class="inv-group">
        <h4>${esc(group.category)}</h4>
        <div class="day-picker">
          ${group.items.map((name) => {
            const already = alreadyHaveLower.includes(name.toLowerCase());
            return `<label>
              <input type="checkbox" data-staple="${esc(name)}" data-staple-cat="${esc(group.category)}" ${already ? "checked disabled" : ""}>
              ${esc(name)}${already ? " ✓" : ""}
            </label>`;
          }).join("")}
        </div>
      </div>`).join("");
  }

  // Bulk-inserts whatever's checked (and not disabled, i.e. not already in inventory) within
  // `root`. Returns how many rows were added, purely so callers can decide what to say/do next.
  async function insertSelectedStaples(root) {
    const boxes = Array.from(root.querySelectorAll("[data-staple]:checked:not(:disabled)"));
    if (!boxes.length) return 0;
    await Promise.all(boxes.map((cb) =>
      Dinero.db("inventory_items").insert([{ household_id: state.uid, category: cb.dataset.stapleCat, item_name: cb.dataset.staple }])
    ));
    return boxes.length;
  }

  async function renderInventar(main) {
    // FIX (feedback item 7): a real <select>, always freely reselectable — the old
    // <input list="…"> combobox left the typed suggestion text sitting in the field after a
    // pick, so choosing a *different* category meant manually clearing it first. The stored
    // `category` column stays plain free text (no schema/enum change), so "Annet" still
    // reveals a small custom-text input for anything not in the fixed suggestion list —
    // and renderInventoryGroups() below still groups by whatever string is on each row, so
    // pre-existing custom categories a household already typed keep grouping/displaying fine.
    main.innerHTML = `
      <div class="inv-add-row">
        <select id="inv-category">
          ${INVENTORY_CATEGORY_SUGGESTIONS.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
        </select>
        <input type="text" id="inv-category-custom" placeholder="Skriv kategorinavn" style="display:none;">
        <input type="text" id="inv-item" placeholder="Vare, f.eks. laksefilet">
        <button id="inv-add">Legg til</button>
      </div>
      <button type="button" class="add-link-btn" id="inv-staples-toggle">+ Foreslå faste varer</button>
      <div id="inv-staples-box" style="display:none; margin: 12px 0 20px;"></div>
      <div id="inv-groups"><div class="hint">Laster …</div></div>
    `;
    const catSelect = document.getElementById("inv-category");
    const catCustom = document.getElementById("inv-category-custom");
    function syncCustomVisibility() {
      catCustom.style.display = catSelect.value === "Annet" ? "inline-block" : "none";
    }
    catSelect.onchange = syncCustomVisibility;
    syncCustomVisibility();

    document.getElementById("inv-add").onclick = guard(async () => {
      const itemEl = document.getElementById("inv-item");
      const category = catSelect.value === "Annet"
        ? (catCustom.value.trim() || "Annet")
        : catSelect.value;
      const itemName = itemEl.value.trim();
      if (!itemName) return;
      await Dinero.db("inventory_items").insert([{ household_id: state.uid, category: category, item_name: itemName }]);
      itemEl.value = "";
      catCustom.value = "";
      await loadInventory();
      renderInventoryGroups();
    });
    ["inv-category-custom", "inv-item"].forEach((id) => {
      document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("inv-add").click(); });
    });

    const staplesBox = document.getElementById("inv-staples-box");
    document.getElementById("inv-staples-toggle").onclick = () => {
      const isOpen = staplesBox.style.display !== "none";
      if (isOpen) { staplesBox.style.display = "none"; return; }
      staplesBox.innerHTML = `
        <div class="hint">Huk av det dere alltid har hjemme — varer som allerede står i inventaret er forhåndshuket.</div>
        ${staplesChecklistHtml(state.inventoryNames)}
        <button type="button" id="inv-staples-add">Legg til valgte</button>
      `;
      staplesBox.style.display = "block";
      document.getElementById("inv-staples-add").onclick = guard(async () => {
        await insertSelectedStaples(staplesBox);
        staplesBox.style.display = "none";
        await loadInventory();
        renderInventoryGroups();
      });
    };

    try {
      await loadInventory();
    } catch (e) {
      showBanner("app-banner", "Fikk ikke lastet inventaret: " + errMsg(e));
    }
    renderInventoryGroups();
  }

  function renderInventoryGroups() {
    const el = document.getElementById("inv-groups");
    if (!el) return;
    if (!state.inventory.length) {
      el.innerHTML = `<div class="inv-empty">Ingen varer registrert ennå. Legg til det dere har i fryser, kjøleskap og skap over.</div>`;
      return;
    }
    const groups = new Map();
    state.inventory.forEach((item) => {
      if (!groups.has(item.category)) groups.set(item.category, []);
      groups.get(item.category).push(item);
    });
    el.innerHTML = Array.from(groups.entries()).map(([cat, items]) => `
      <div class="inv-group">
        <h4>${esc(cat)}</h4>
        <div class="inv-items">
          ${items.map((item) => `
            <span class="inv-chip">
              <span data-inv-text="${item.id}">${esc(item.item_name)}</span>
              <button data-inv-edit="${item.id}" title="Rediger">✎</button>
              <button data-inv-remove="${item.id}" title="Fjern">✕</button>
            </span>`).join("")}
        </div>
      </div>`).join("");
    el.querySelectorAll("[data-inv-remove]").forEach((btn) => {
      btn.onclick = guard(async () => {
        await Dinero.db("inventory_items").delete({ id: "eq." + btn.dataset.invRemove });
        await loadInventory();
        renderInventoryGroups();
      });
    });

    // ADDED (2026-09-07, "jeg må slette alt og skrive på nytt" — she'd been maintaining
    // inventory as delete-and-retype because item_name had no UPDATE path at all before this).
    // Turns a chip's text into an inline input on click; Enter/blur saves, Escape cancels back
    // to the original text. Emptying the field or leaving it unchanged saves nothing (re-renders
    // as a no-op) — you can never lose an item by accident through this control. A `done` flag
    // stops the Enter-then-blur sequence from firing the same save twice.
    el.querySelectorAll("[data-inv-edit]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.invEdit;
        const textEl = el.querySelector(`[data-inv-text="${id}"]`);
        const item = state.inventory.find((r) => String(r.id) === String(id));
        if (!textEl || !item) return;
        const original = item.item_name;
        textEl.outerHTML = `<input type="text" data-inv-text="${id}" value="${esc(original)}">`;
        const input = el.querySelector(`input[data-inv-text="${id}"]`);
        input.focus();
        input.select();
        let done = false;
        const save = guard(async () => {
          if (done) return;
          done = true;
          const val = input.value.trim();
          if (!val || val === original) { renderInventoryGroups(); return; }
          await Dinero.db("inventory_items").update({ item_name: val }, { id: "eq." + id });
          await loadInventory();
          renderInventoryGroups();
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          if (e.key === "Escape") { e.preventDefault(); if (!done) { done = true; renderInventoryGroups(); } }
        });
        input.addEventListener("blur", () => save());
      };
    });
  }

  // ---------- public entry points ----------
  window.DineroApp = { showOnboarding, showApp };
})();
