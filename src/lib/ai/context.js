/**
 * AI design context — the conversation's durable memory.
 *
 * The provider message history carries the raw turns, but it has no stable
 * binding from the English nouns a user uses ("the bracket", "the baseplate")
 * to the feature/component ids the tools need, no ledger of measurable
 * requirements to hold the design accountable to, and no record of decisions
 * the assistant can explain later. This module is that memory.
 *
 * It is a process-local singleton (one design session per loaded document),
 * serialisable via snapshot()/restore() so a saved/reloaded session keeps its
 * vocabulary. Nothing here throws — every accessor is defensive so a malformed
 * call from a weak model can never break the agent loop.
 *
 *   getAIContext()                       → the singleton
 *   ctx.alias(name, id)                  → bind an English name to an id
 *   ctx.resolveRef(nameOrId)             → id (alias-aware; echoes input if none)
 *   ctx.recordDecision(what, why)        → append to the decision log
 *   ctx.addRequirement({...})            → ledger a measurable requirement
 *   ctx.setBrief(brief) / ctx.brief      → the structured design brief
 *   ctx.contextBlock()                   → compact text to inject each turn
 *   ctx.reset()                          → wipe (Clear chat)
 *   ctx.snapshot() / ctx.restore(s)      → persistence
 */

let _shared = null;

class AIContext {
    constructor() {
        this.reset();
    }

    reset() {
        /** lowercased name → { id, name } */
        this.aliases = new Map();
        /** [{ what, why, turn }] */
        this.decisions = [];
        /** [{ id, text, kind, comparator, value, unit, target, status }] */
        this.requirements = [];
        this.units = 'mm';
        /** 'auto' | 'novice' | 'expert' */
        this.fluency = 'auto';
        /** structured design brief or null */
        this._brief = null;
        // ── Functional-design state (the DSO — see PLAN-functional-design-brain.md)
        /** morphology + kinematic spec (plan_mechanism) or null */
        this._morphology = null;
        /** skeleton layout / massing envelope (plan_skeleton_envelope) or null */
        this._skeleton = null;
        /** assembly + serviceability plan (plan_serviceability) or null */
        this._assemblyPlan = null;
        /** research / pattern spec (mine_patterns) or null */
        this._research = null;
        /** partId → { hosts, recipe, load, wall, neighbors } binding */
        this._partBindings = new Map();
        this.turn = 0;
        this._reqSeq = 0;
    }

    /** Advance the turn counter (called once per user message). */
    bumpTurn() { this.turn += 1; return this.turn; }

    // ── Aliases ──────────────────────────────────────────────────────────────
    alias(name, id) {
        if (typeof name !== 'string' || !name.trim() || typeof id !== 'string' || !id.trim()) return false;
        this.aliases.set(name.trim().toLowerCase(), { id: id.trim(), name: name.trim() });
        return true;
    }

    /**
     * Resolve a reference that may be an English alias OR a literal id. Returns
     * the bound id when `nameOrId` matches a known alias; otherwise echoes the
     * input unchanged (so a real id passes straight through).
     */
    resolveRef(nameOrId) {
        if (typeof nameOrId !== 'string') return nameOrId;
        const hit = this.aliases.get(nameOrId.trim().toLowerCase());
        return hit ? hit.id : nameOrId;
    }

    /**
     * Drop aliases whose target no longer exists. The caller passes the set of
     * live feature/component ids (the context module deliberately has no
     * dependency on the document layer, so it can't fetch them itself). Called
     * with no argument it is a no-op (keeps all aliases).
     */
    reconcile(knownIds) {
        if (!knownIds) return;
        const known = (knownIds instanceof Set) ? knownIds : new Set(knownIds);
        for (const [key, entry] of [...this.aliases.entries()]) {
            if (!known.has(entry.id)) this.aliases.delete(key);
        }
    }

    // ── Decisions ──────────────────────────────────────────────────────────────
    recordDecision(what, why) {
        if (typeof what !== 'string' || !what.trim()) return false;
        this.decisions.push({ what: what.trim(), why: (why && String(why)) || '', turn: this.turn });
        // Keep the log bounded so the injected block stays small.
        if (this.decisions.length > 40) this.decisions.splice(0, this.decisions.length - 40);
        return true;
    }

    findDecision(topic) {
        if (typeof topic !== 'string') return null;
        const t = topic.trim().toLowerCase();
        // Most-recent match wins.
        for (let i = this.decisions.length - 1; i >= 0; i--) {
            const d = this.decisions[i];
            if (d.what.toLowerCase().includes(t) || (d.why || '').toLowerCase().includes(t)) return d;
        }
        return null;
    }

    // ── Requirements ledger ─────────────────────────────────────────────────────
    addRequirement(req) {
        if (!req || typeof req !== 'object' || typeof req.text !== 'string' || !req.text.trim()) return null;
        const id = `req_${++this._reqSeq}`;
        const rec = {
            id,
            text: req.text.trim(),
            kind: req.kind || 'note',
            comparator: req.comparator || null,
            value: Number.isFinite(req.value) ? req.value : null,
            unit: req.unit || this.units,
            target: req.target || null,
            status: 'unknown',
        };
        this.requirements.push(rec);
        if (this.requirements.length > 40) this.requirements.splice(0, this.requirements.length - 40);
        return rec;
    }

    setRequirementStatus(id, status, measured) {
        const r = this.requirements.find((x) => x.id === id);
        if (!r) return false;
        r.status = status;
        if (measured !== undefined) r.measured = measured;
        return true;
    }

    // ── Brief ────────────────────────────────────────────────────────────────
    setBrief(brief) { this._brief = (brief && typeof brief === 'object') ? brief : null; return this._brief; }
    get brief() { return this._brief; }

    setUnits(u) { if (typeof u === 'string' && u.trim()) this.units = u.trim(); }
    setFluency(f) { if (['auto', 'novice', 'expert'].includes(f)) this.fluency = f; }

    // ── Functional-design state (DSO) ──────────────────────────────────────────
    // Every setter is defensive (a malformed spec from a weak model becomes null,
    // never a throw) and every getter is read-only. These feed the verification
    // gates (i-functional-complete, i-motion-clearance, design_review) and the
    // per-turn context block.
    setMorphology(spec) { this._morphology = (spec && typeof spec === 'object') ? spec : null; return this._morphology; }
    get morphology() { return this._morphology; }
    setSkeleton(spec) { this._skeleton = (spec && typeof spec === 'object') ? spec : null; return this._skeleton; }
    get skeleton() { return this._skeleton; }
    setAssemblyPlan(spec) { this._assemblyPlan = (spec && typeof spec === 'object') ? spec : null; return this._assemblyPlan; }
    get assemblyPlan() { return this._assemblyPlan; }
    setResearch(spec) { this._research = (spec && typeof spec === 'object') ? spec : null; return this._research; }
    get research() { return this._research; }
    bindPart(partId, binding) {
        if (typeof partId !== 'string' || !partId.trim()) return false;
        if (!binding || typeof binding !== 'object') return false;
        this._partBindings.set(partId.trim(), binding);
        return true;
    }
    partBinding(partId) { return (typeof partId === 'string' && this._partBindings.get(partId)) || null; }
    get partBindings() { return this._partBindings; }

    // ── Snapshot / restore ──────────────────────────────────────────────────────
    snapshot() {
        return {
            aliases: [...this.aliases.values()],
            decisions: this.decisions.slice(),
            requirements: this.requirements.slice(),
            units: this.units,
            fluency: this.fluency,
            brief: this._brief,
            morphology: this._morphology,
            skeleton: this._skeleton,
            assemblyPlan: this._assemblyPlan,
            research: this._research,
            partBindings: [...this._partBindings.entries()],
            turn: this.turn,
        };
    }

    restore(s) {
        this.reset();
        if (!s || typeof s !== 'object') return;
        try {
            for (const a of s.aliases || []) this.alias(a.name, a.id);
            this.decisions = Array.isArray(s.decisions) ? s.decisions.slice() : [];
            this.requirements = Array.isArray(s.requirements) ? s.requirements.slice() : [];
            this._reqSeq = this.requirements.length;
            if (typeof s.units === 'string') this.units = s.units;
            if (typeof s.fluency === 'string') this.fluency = s.fluency;
            this._brief = (s.brief && typeof s.brief === 'object') ? s.brief : null;
            this._morphology = (s.morphology && typeof s.morphology === 'object') ? s.morphology : null;
            this._skeleton = (s.skeleton && typeof s.skeleton === 'object') ? s.skeleton : null;
            this._assemblyPlan = (s.assemblyPlan && typeof s.assemblyPlan === 'object') ? s.assemblyPlan : null;
            this._research = (s.research && typeof s.research === 'object') ? s.research : null;
            this._partBindings = new Map(Array.isArray(s.partBindings) ? s.partBindings.filter((e) => Array.isArray(e) && e.length === 2) : []);
            this.turn = Number.isFinite(s.turn) ? s.turn : 0;
        } catch { /* ignore corrupt snapshot */ }
    }

    /**
     * A compact text block describing the live context, injected into the
     * system prompt each turn so the model can resolve "the bracket", remember
     * decisions, and re-check requirements. Returns '' when there is nothing to
     * say (a fresh session) so we don't bloat the prompt.
     */
    contextBlock(knownIds) {
        this.reconcile(knownIds);
        const lines = [];
        if (this.aliases.size) {
            const pairs = [...this.aliases.values()].map((a) => `"${a.name}" → ${a.id}`).join(', ');
            lines.push(`Named things: ${pairs}`);
        }
        if (this._brief) {
            try { lines.push(`Design brief: ${JSON.stringify(this._brief)}`); } catch { /* skip */ }
        }
        const openReqs = this.requirements.filter((r) => r.status !== 'met');
        if (openReqs.length) {
            const r = openReqs.slice(-8).map((x) => `${x.text} [${x.status}]`).join('; ');
            lines.push(`Requirements to satisfy: ${r}`);
        }
        if (this.decisions.length) {
            const d = this.decisions.slice(-6).map((x) => x.why ? `${x.what} (${x.why})` : x.what).join('; ');
            lines.push(`Decisions so far: ${d}`);
        }
        // Functional-design state (the pipeline's running spec) — so the model
        // always knows what mechanism it committed to and what's left to satisfy.
        const m = this._morphology;
        if (m && typeof m === 'object') {
            const dof = Number.isFinite(m.dof) ? `${m.dof} DOF` : '';
            const kp = Number.isFinite(m.kinematicPoints) ? `${m.kinematicPoints} moving joints` : '';
            const nj = Array.isArray(m.joints) ? m.joints.length : 0;
            lines.push(`Mechanism committed: ${m.archetype || 'custom'} — ${[dof, kp].filter(Boolean).join(', ') || `${nj} joints`}. EVERY joint needs an actuator + a structural mount (i-functional-complete will fail otherwise).`);
        }
        if (this._skeleton && Array.isArray(this._skeleton.hosts)) {
            lines.push(`Skeleton laid out: ${this._skeleton.hosts.length} hosted component(s) in the envelope.`);
        }
        if (this._assemblyPlan) {
            const rep = Array.isArray(this._assemblyPlan.replaceable) ? this._assemblyPlan.replaceable.length : 0;
            const baked = Array.isArray(this._assemblyPlan.bakedIn) ? this._assemblyPlan.bakedIn.length : 0;
            lines.push(`Serviceability: ${rep} replaceable (keep accessible), ${baked} baked-in.`);
        }
        if (this.fluency !== 'auto') lines.push(`User fluency: ${this.fluency}.`);
        if (!lines.length) return '';
        return `# Design context (your memory of this session)\n${lines.map((l) => `- ${l}`).join('\n')}`;
    }
}

/** The process-local design-context singleton. */
export function getAIContext() {
    if (!_shared) _shared = new AIContext();
    return _shared;
}

export default getAIContext;
