// BotCreateWizard — five steps to a standing mission, on the KBCreateWizard
// pattern: library Modal, per-step validation with touched sets, a step
// indicator bar, deferred reset on close, and errors as an in-modal banner.
//
// The template shapes the outcome contract; the mission is WRITTEN, not
// picked — a recurring "tech-debt hunter" is a Bug-template bot with a written
// mission and a cron trigger. Nothing here escapes governance: every change a
// bot ships still passes review + policy gates.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, FilterChip, FormField, Modal } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { DEVBOX_MODELS, DEFAULT_DEVBOX_MODEL } from '../../lib/devboxModels';
import type { Bot } from './BotsPage';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface BotCreateWizardProps {
  open: boolean;
  onClose: () => void;
}

// ─── Option feeds ─────────────────────────────────────────────────────────────

interface AgentProjectOpt {
  id: string;
  repoFullName: string;
  orgProjectId: string | null;
  orgProjectName: string | null;
  sessionId: string | null;
}
interface OrgProjectOpt { id: string; name: string; status: string | null }
interface DevboxStatus { allowedModels?: string[]; defaultModel?: string | null }
interface Estimate {
  basis: 'repo' | 'model' | 'prior';
  sampleCount: number;
  costUsdP25: number;
  costUsdP75: number;
  minutesP25: number;
  minutesP75: number;
}

// ─── Step 1 — Template & mission ─────────────────────────────────────────────

const TEMPLATES: Array<{ id: 'epic' | 'story' | 'bug'; label: string; blurb: string }> = [
  { id: 'epic',  label: 'Epic',  blurb: 'container — groups stories and bugs; never dispatched itself' },
  { id: 'story', label: 'Story', blurb: 'a sized change' },
  { id: 'bug',   label: 'Bug',   blurb: 'a defect with a repro' },
];

interface Step1State { name: string; template: 'epic' | 'story' | 'bug' | null; prompt: string }
interface Step1Errors { name?: string; template?: string; prompt?: string }

function validateStep1(s: Step1State): Step1Errors {
  const errors: Step1Errors = {};
  if (!s.name.trim()) errors.name = 'Name is required.';
  else if (s.name.trim().length > 100) errors.name = 'Name must be 100 characters or fewer.';
  if (!s.template) errors.template = 'Pick a template.';
  if (!s.prompt.trim()) errors.prompt = 'The mission is required — a bot without one has nothing to do.';
  return errors;
}

// ─── Step 2 — Target ─────────────────────────────────────────────────────────

interface Step2State { targetKind: 'codebase' | 'initiative'; agentProjectId: string; orgProjectId: string }
interface Step2Errors { target?: string }

function validateStep2(s: Step2State): Step2Errors {
  const errors: Step2Errors = {};
  if (s.targetKind === 'codebase' && !s.agentProjectId) errors.target = 'Pick a codebase.';
  if (s.targetKind === 'initiative' && !s.orgProjectId) errors.target = 'Pick an initiative.';
  return errors;
}

// ─── Step 3 — Guardrails ─────────────────────────────────────────────────────

interface Step3State {
  model: string;
  budgetPerRunUsd: string;
  budgetPerDayUsd: string;
  maxRunsPerDay: number;
  requiresReview: boolean;
}
interface Step3Errors { budgetPerRunUsd?: string; budgetPerDayUsd?: string; maxRunsPerDay?: string }

function validateStep3(s: Step3State): Step3Errors {
  const errors: Step3Errors = {};
  const perRun = s.budgetPerRunUsd.trim();
  const perDay = s.budgetPerDayUsd.trim();
  if (perRun !== '' && (!Number.isFinite(Number(perRun)) || Number(perRun) <= 0)) {
    errors.budgetPerRunUsd = 'Must be a positive dollar amount, or empty for no cap.';
  }
  if (perDay !== '' && (!Number.isFinite(Number(perDay)) || Number(perDay) <= 0)) {
    errors.budgetPerDayUsd = 'Must be a positive dollar amount, or empty for no cap.';
  }
  if (!Number.isInteger(s.maxRunsPerDay) || s.maxRunsPerDay < 1) {
    errors.maxRunsPerDay = 'At least 1 run per day.';
  }
  return errors;
}

// ─── Step 4 — Trigger ────────────────────────────────────────────────────────

const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: 'hourly', expr: '0 * * * *' },
  { label: 'daily 9am', expr: '0 9 * * *' },
  { label: 'weekly Mon 9am', expr: '0 9 * * 1' },
];

interface Step4State { trigger: 'manual' | 'cron' | 'pr_watch'; cronExpr: string }
interface Step4Errors { cronExpr?: string; trigger?: string }

function validateStep4(s: Step4State, step2: Step2State): Step4Errors {
  const errors: Step4Errors = {};
  if (s.trigger === 'cron') {
    if (!s.cronExpr.trim()) errors.cronExpr = 'A cron expression is required.';
    else if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(s.cronExpr.trim())) {
      errors.cronExpr = 'Five space-separated fields (min hour dom month dow).';
    }
  }
  if (s.trigger === 'pr_watch' && (step2.targetKind !== 'codebase' || !step2.agentProjectId)) {
    errors.trigger = 'On-new-PRs needs a codebase target — go back to step 2 and pick one.';
  }
  return errors;
}

// ─── Wizard ──────────────────────────────────────────────────────────────────

const STEP_LABELS = ['Template', 'Target', 'Guardrails', 'Trigger', 'Review & launch'] as const;

export function BotCreateWizard({ open, onClose }: BotCreateWizardProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);

  const [step1, setStep1] = useState<Step1State>({ name: '', template: null, prompt: '' });
  const [step2, setStep2] = useState<Step2State>({ targetKind: 'codebase', agentProjectId: '', orgProjectId: '' });
  const [step3, setStep3] = useState<Step3State>({
    model: DEFAULT_DEVBOX_MODEL, budgetPerRunUsd: '', budgetPerDayUsd: '', maxRunsPerDay: 4, requiresReview: true,
  });
  const [step4, setStep4] = useState<Step4State>({ trigger: 'manual', cronExpr: '' });

  const [step1Touched, setStep1Touched] = useState<Set<keyof Step1Errors>>(new Set());
  const [step2Touched, setStep2Touched] = useState<Set<keyof Step2Errors>>(new Set());
  const [step3Touched, setStep3Touched] = useState<Set<keyof Step3Errors>>(new Set());
  const [step4Touched, setStep4Touched] = useState<Set<keyof Step4Errors>>(new Set());

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdBot, setCreatedBot] = useState<Bot | null>(null);

  // Option feeds — fetched only while the modal is open.
  const { data: projectsData } = useFetch<{ projects: AgentProjectOpt[] }>(open ? '/api/agent-projects' : null);
  const { data: orgProjects } = useFetch<OrgProjectOpt[]>(open ? '/api/graph/projects' : null);
  const { data: devboxStatus } = useFetch<DevboxStatus>(open ? '/api/devbox/status' : null);

  const projects = projectsData?.projects ?? [];
  // Deployed allowlist ∩ the shared model list; fall back to the shared list
  // so an unreachable status endpoint never empties the picker.
  const allowed = devboxStatus?.allowedModels;
  const filtered = allowed?.length ? DEVBOX_MODELS.filter((m) => allowed.includes(m.id)) : DEVBOX_MODELS;
  const models = filtered.length > 0 ? filtered : DEVBOX_MODELS;

  // Keep the chosen model on the allowlist once it loads.
  useEffect(() => {
    if (!models.some((m) => m.id === step3.model)) {
      setStep3((prev) => ({ ...prev, model: models[0]!.id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devboxStatus]);

  // Estimate — fetched when the review step is reached.
  const estimateUrl = open && step === 5
    ? `/api/bots/estimate?model=${encodeURIComponent(step3.model)}${
        step2.targetKind === 'codebase' && step2.agentProjectId
          ? `&agentProjectId=${encodeURIComponent(step2.agentProjectId)}`
          : ''
      }`
    : null;
  const { data: estimate, isLoading: estimateLoading, error: estimateError } = useFetch<Estimate>(estimateUrl);

  // Tracks the pending reset timer so we can clear it on unmount / re-open.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  // Reset wizard state when closed (deferred so the close animation isn't jarring).
  useEffect(() => {
    if (!open) {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => {
        setStep(1);
        setStep1({ name: '', template: null, prompt: '' });
        setStep2({ targetKind: 'codebase', agentProjectId: '', orgProjectId: '' });
        setStep3({ model: DEFAULT_DEVBOX_MODEL, budgetPerRunUsd: '', budgetPerDayUsd: '', maxRunsPerDay: 4, requiresReview: true });
        setStep4({ trigger: 'manual', cronExpr: '' });
        setStep1Touched(new Set());
        setStep2Touched(new Set());
        setStep3Touched(new Set());
        setStep4Touched(new Set());
        setSubmitting(false);
        setSubmitError(null);
        setCreatedBot(null);
      }, 200);
    }
  }, [open]);

  // ── Derived validation ──────────────────────────────────────────────────────

  const step1Errors = validateStep1(step1);
  const step2Errors = validateStep2(step2);
  const step3Errors = validateStep3(step3);
  const step4Errors = validateStep4(step4, step2);
  const stepValid = [
    Object.keys(step1Errors).length === 0,
    Object.keys(step2Errors).length === 0,
    Object.keys(step3Errors).length === 0,
    Object.keys(step4Errors).length === 0,
  ];

  function handleNext() {
    setSubmitError(null);
    if (step === 1) {
      setStep1Touched(new Set<keyof Step1Errors>(['name', 'template', 'prompt']));
      if (!stepValid[0]) return;
    } else if (step === 2) {
      setStep2Touched(new Set<keyof Step2Errors>(['target']));
      if (!stepValid[1]) return;
    } else if (step === 3) {
      setStep3Touched(new Set<keyof Step3Errors>(['budgetPerRunUsd', 'budgetPerDayUsd', 'maxRunsPerDay']));
      if (!stepValid[2]) return;
    } else if (step === 4) {
      setStep4Touched(new Set<keyof Step4Errors>(['cronExpr', 'trigger']));
      if (!stepValid[3]) return;
    }
    setStep((s) => Math.min(5, s + 1) as typeof step);
  }

  function handleBack() {
    setSubmitError(null);
    setStep((s) => Math.max(1, s - 1) as typeof step);
  }

  async function handleLaunch() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/bots', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: step1.name.trim(),
          template: step1.template,
          prompt: step1.prompt.trim(),
          agentProjectId: step2.targetKind === 'codebase' ? step2.agentProjectId : null,
          orgProjectId: step2.targetKind === 'initiative' ? step2.orgProjectId : null,
          model: step3.model,
          trigger: step4.trigger,
          cronExpr: step4.trigger === 'cron' ? step4.cronExpr.trim() : null,
          budgetPerRunUsd: step3.budgetPerRunUsd.trim() === '' ? null : Number(step3.budgetPerRunUsd),
          budgetPerDayUsd: step3.budgetPerDayUsd.trim() === '' ? null : Number(step3.budgetPerDayUsd),
          maxRunsPerDay: step3.maxRunsPerDay,
          requiresReview: step3.requiresReview,
        }),
      });
      const body = await res.json().catch(() => ({})) as { bot?: Bot; error?: string; message?: string };
      if (res.status !== 201 || !body.bot) {
        setSubmitError(body.error ?? body.message ?? `HTTP ${res.status}`);
        return;
      }
      setCreatedBot(body.bot);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  function openDetail(bot: Bot) {
    onClose();
    navigate(`/admin/bots/${bot.id}`);
  }

  async function runNowAndOpen() {
    const bot = createdBot;
    if (!bot) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bots/${bot.id}/run`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (res.status === 409) toastError(null, 'Not run', body.error ?? 'The bot refused this run.');
      else if (!res.ok) toastError(null, 'Could not start', body.error ?? `HTTP ${res.status}`);
      else toastSuccess(null, 'First run started', 'It streams on the bot page as it works.');
    } catch (err) {
      toastError(null, 'Could not start', (err as Error).message);
    } finally {
      setSubmitting(false);
      openDetail(bot);
    }
  }

  // ── Small shared bits ───────────────────────────────────────────────────────

  const inputCls = 'w-full px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary box-border';
  const selectedRepo = projects.find((p) => p.id === step2.agentProjectId);
  const selectedInitiative = (orgProjects ?? []).find((p) => p.id === step2.orgProjectId);
  const targetLabel = step2.targetKind === 'codebase'
    ? (selectedRepo?.repoFullName ?? '—')
    : (selectedInitiative?.name ?? '—');
  const modelLabel = models.find((m) => m.id === step3.model)?.label ?? step3.model;

  // ─── Layout ──────────────────────────────────────────────────────────────────

  const footer = createdBot ? (
    <>
      <Button variant="secondary" disabled={submitting} onClick={() => openDetail(createdBot)}>
        Open bot
      </Button>
      <Button variant="primary" disabled={submitting} onClick={() => void runNowAndOpen()}>
        {submitting ? 'Starting…' : '▶ Run now'}
      </Button>
    </>
  ) : (
    <>
      {step > 1 && (
        <Button variant="secondary" onClick={handleBack}>
          Back
        </Button>
      )}
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      {step < 5 ? (
        <Button variant="primary" onClick={handleNext}>
          Next →
        </Button>
      ) : (
        <Button variant="primary" disabled={submitting} onClick={() => void handleLaunch()}>
          {submitting ? 'Launching…' : 'Launch bot'}
        </Button>
      )}
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={createdBot ? `${createdBot.name} is live` : `New bot — Step ${step} of 5 — ${STEP_LABELS[step - 1]}`}
      maxWidth={560}
      footer={footer}
    >
      {/* Step indicator bar */}
      <div style={{ display: 'flex', height: 3, marginBottom: 16 }}>
        {([1, 2, 3, 4, 5] as const).map((n) => (
          <div
            key={n}
            style={{
              flex: 1,
              background: n <= step ? 'var(--color-primary)' : 'var(--color-border)',
              transition: 'background 0.3s',
            }}
          />
        ))}
      </div>

      {createdBot ? (
        <div className="text-[12.5px] text-text-secondary leading-relaxed">
          <p className="m-0">
            <b className="text-text-primary">{createdBot.name}</b> is created
            {step4.trigger === 'cron' ? ` and will fire on ${step4.cronExpr}` : ''}
            {step4.trigger === 'pr_watch' ? ' — the PR trigger is stored and activates with the PR poller' : ''}.
          </p>
          <p className="mt-2 mb-0">
            Fire the first run now to watch it work live, or open the bot page — every change it makes
            still lands in the Changes review queue.
          </p>
        </div>
      ) : (
        <>
          {/* ── Step 1 — Template & mission ── */}
          {step === 1 && (
            <div>
              <FormField label="Name" required error={step1Touched.has('name') ? step1Errors.name : undefined}>
                {(p) => (
                  <input
                    {...p}
                    value={step1.name}
                    onChange={(e) => setStep1((prev) => ({ ...prev, name: e.target.value }))}
                    onBlur={() => setStep1Touched((prev) => new Set([...prev, 'name']))}
                    placeholder="e.g. Tech-debt hunter"
                    maxLength={100}
                  />
                )}
              </FormField>

              <FormField
                label="Template"
                required
                error={step1Touched.has('template') ? step1Errors.template : undefined}
                hint="The template shapes the outcome contract — the mission below says what to do."
              >
                {() => (
                  <div className="grid grid-cols-3 gap-2">
                    {TEMPLATES.map((t) => {
                      const active = step1.template === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setStep1((prev) => ({ ...prev, template: t.id }));
                            setStep1Touched((prev) => new Set([...prev, 'template']));
                          }}
                          className={`text-left px-2.5 py-2 rounded-md border cursor-pointer transition-colors bg-surface ${
                            active ? 'border-primary ring-1 ring-primary/40 bg-primary/5' : 'border-border hover:border-primary/50'
                          }`}
                        >
                          <div className={`text-[12px] font-semibold ${active ? 'text-primary' : 'text-text-primary'}`}>{t.label}</div>
                          <div className="text-[10.5px] text-text-tertiary leading-snug mt-0.5">{t.blurb}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </FormField>

              <FormField
                label="The mission"
                required
                error={step1Touched.has('prompt') ? step1Errors.prompt : undefined}
                hint="What should this bot do? Written, not picked."
              >
                {(p) => (
                  <textarea
                    {...p}
                    style={{ resize: 'vertical', minHeight: 96 }}
                    value={step1.prompt}
                    onChange={(e) => setStep1((prev) => ({ ...prev, prompt: e.target.value }))}
                    onBlur={() => setStep1Touched((prev) => new Set([...prev, 'prompt']))}
                    placeholder="e.g. Hunt down dead code and unused dependencies. Prefer many small, reviewable changes over one sweeping one. Never touch generated files."
                  />
                )}
              </FormField>
            </div>
          )}

          {/* ── Step 2 — Target ── */}
          {step === 2 && (
            <div>
              <FormField
                label="What does it work on?"
                required
                error={step2Touched.has('target') ? step2Errors.target : undefined}
              >
                {() => (
                  <div className="flex flex-col gap-2.5">
                    <label className="flex items-start gap-2 text-[12px] text-text-primary cursor-pointer">
                      <input
                        type="radio"
                        name="bot-target-kind"
                        checked={step2.targetKind === 'codebase'}
                        onChange={() => setStep2((prev) => ({ ...prev, targetKind: 'codebase' }))}
                        className="mt-0.5"
                      />
                      <span className="flex-1">
                        <span className="font-semibold">Codebase</span>
                        <span className="text-text-tertiary"> — a linked repository the bot changes directly</span>
                        {step2.targetKind === 'codebase' && (
                          <span className="block mt-1.5">
                            <select
                              value={step2.agentProjectId}
                              onChange={(e) => {
                                setStep2((prev) => ({ ...prev, agentProjectId: e.target.value }));
                                setStep2Touched((prev) => new Set([...prev, 'target']));
                              }}
                              className={inputCls}
                            >
                              <option value="">— pick a codebase —</option>
                              {projects.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.repoFullName}{p.orgProjectName ? ` · ${p.orgProjectName}` : ''}
                                </option>
                              ))}
                            </select>
                            {projects.length === 0 && (
                              <span className="block text-[11px] text-text-tertiary mt-1">
                                No codebases linked yet — link a repository in Codebases first.
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                    </label>

                    <label className="flex items-start gap-2 text-[12px] text-text-primary cursor-pointer">
                      <input
                        type="radio"
                        name="bot-target-kind"
                        checked={step2.targetKind === 'initiative'}
                        onChange={() => setStep2((prev) => ({ ...prev, targetKind: 'initiative' }))}
                        className="mt-0.5"
                      />
                      <span className="flex-1">
                        <span className="font-semibold">Initiative</span>
                        <span className="text-text-tertiary"> — an org initiative the bot serves</span>
                        {step2.targetKind === 'initiative' && (
                          <span className="block mt-1.5">
                            <select
                              value={step2.orgProjectId}
                              onChange={(e) => {
                                setStep2((prev) => ({ ...prev, orgProjectId: e.target.value }));
                                setStep2Touched((prev) => new Set([...prev, 'target']));
                              }}
                              className={inputCls}
                            >
                              <option value="">— pick an initiative —</option>
                              {(orgProjects ?? []).map((op) => (
                                <option key={op.id} value={op.id}>{op.name}</option>
                              ))}
                            </select>
                          </span>
                        )}
                      </span>
                    </label>
                  </div>
                )}
              </FormField>
              <div className="text-[11px] text-text-tertiary">
                The on-new-PRs trigger (step 4) requires a codebase target.
              </div>
            </div>
          )}

          {/* ── Step 3 — Guardrails ── */}
          {step === 3 && (
            <div>
              <FormField label="Model" hint={models.find((m) => m.id === step3.model)?.hint}>
                {(p) => (
                  <select
                    {...p}
                    value={step3.model}
                    onChange={(e) => setStep3((prev) => ({ ...prev, model: e.target.value }))}
                  >
                    {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                )}
              </FormField>

              <FormField
                label="Budget per run ($)"
                error={step3Touched.has('budgetPerRunUsd') ? step3Errors.budgetPerRunUsd : undefined}
                hint="Soft cap — a run that exceeds it is flagged. Empty for none."
              >
                {(p) => (
                  <input
                    {...p}
                    type="number" min={0} step="0.01" placeholder="none"
                    value={step3.budgetPerRunUsd}
                    onChange={(e) => setStep3((prev) => ({ ...prev, budgetPerRunUsd: e.target.value }))}
                    onBlur={() => setStep3Touched((prev) => new Set([...prev, 'budgetPerRunUsd']))}
                  />
                )}
              </FormField>

              <FormField
                label="Budget per day ($)"
                error={step3Touched.has('budgetPerDayUsd') ? step3Errors.budgetPerDayUsd : undefined}
                hint="Hard cap — the bot pauses itself when today's spend would exceed it. Empty for none."
              >
                {(p) => (
                  <input
                    {...p}
                    type="number" min={0} step="0.01" placeholder="none"
                    value={step3.budgetPerDayUsd}
                    onChange={(e) => setStep3((prev) => ({ ...prev, budgetPerDayUsd: e.target.value }))}
                    onBlur={() => setStep3Touched((prev) => new Set([...prev, 'budgetPerDayUsd']))}
                  />
                )}
              </FormField>

              <FormField
                label="Max runs per day"
                error={step3Touched.has('maxRunsPerDay') ? step3Errors.maxRunsPerDay : undefined}
                hint="Backstops a runaway trigger independently of cost."
              >
                {(p) => (
                  <input
                    {...p}
                    type="number" min={1}
                    value={step3.maxRunsPerDay}
                    onChange={(e) => setStep3((prev) => ({ ...prev, maxRunsPerDay: Number(e.target.value) }))}
                    onBlur={() => setStep3Touched((prev) => new Set([...prev, 'maxRunsPerDay']))}
                  />
                )}
              </FormField>

              <label className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none mt-1">
                <input
                  type="checkbox"
                  checked={step3.requiresReview}
                  onChange={(e) => setStep3((prev) => ({ ...prev, requiresReview: e.target.checked }))}
                />
                Requires review
              </label>
              <div className="text-[11px] text-text-tertiary mt-1">
                Every change still passes independent review and policy gates either way — this adds an explicit human approval.
              </div>
            </div>
          )}

          {/* ── Step 4 — Trigger ── */}
          {step === 4 && (
            <div>
              <FormField
                label="When does it fire?"
                error={step4Touched.has('trigger') ? step4Errors.trigger : undefined}
              >
                {() => (
                  <div className="flex flex-col gap-2.5">
                    <label className="flex items-start gap-2 text-[12px] text-text-primary cursor-pointer">
                      <input
                        type="radio" name="bot-trigger" className="mt-0.5"
                        checked={step4.trigger === 'manual'}
                        onChange={() => setStep4((prev) => ({ ...prev, trigger: 'manual' }))}
                      />
                      <span><span className="font-semibold">Manual</span><span className="text-text-tertiary"> — fires only when you press Run now</span></span>
                    </label>

                    <label className="flex items-start gap-2 text-[12px] text-text-primary cursor-pointer">
                      <input
                        type="radio" name="bot-trigger" className="mt-0.5"
                        checked={step4.trigger === 'cron'}
                        onChange={() => setStep4((prev) => ({ ...prev, trigger: 'cron' }))}
                      />
                      <span className="flex-1">
                        <span className="font-semibold">Cron</span>
                        <span className="text-text-tertiary"> — on a schedule</span>
                        {step4.trigger === 'cron' && (
                          <span className="block mt-1.5">
                            <span className="flex items-center gap-1.5 mb-1.5">
                              {CRON_PRESETS.map((c) => (
                                <FilterChip
                                  key={c.expr}
                                  size="sm"
                                  active={step4.cronExpr === c.expr}
                                  onClick={() => {
                                    setStep4((prev) => ({ ...prev, cronExpr: c.expr }));
                                    setStep4Touched((prev) => new Set([...prev, 'cronExpr']));
                                  }}
                                >
                                  {c.label}
                                </FilterChip>
                              ))}
                            </span>
                            <input
                              value={step4.cronExpr}
                              onChange={(e) => setStep4((prev) => ({ ...prev, cronExpr: e.target.value }))}
                              onBlur={() => setStep4Touched((prev) => new Set([...prev, 'cronExpr']))}
                              placeholder="0 9 * * *"
                              className={`${inputCls} font-mono`}
                            />
                            {step4Touched.has('cronExpr') && step4Errors.cronExpr && (
                              <span className="block text-[11px] text-danger mt-1">{step4Errors.cronExpr}</span>
                            )}
                          </span>
                        )}
                      </span>
                    </label>

                    <label className="flex items-start gap-2 text-[12px] text-text-primary cursor-pointer">
                      <input
                        type="radio" name="bot-trigger" className="mt-0.5"
                        checked={step4.trigger === 'pr_watch'}
                        onChange={() => setStep4((prev) => ({ ...prev, trigger: 'pr_watch' }))}
                      />
                      <span className="flex-1">
                        <span className="font-semibold">On new PRs</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-text-tertiary ml-1.5">
                          stored now, activates with the PR poller
                        </span>
                        {step4.trigger === 'pr_watch' && (
                          <span className="block text-[11px] text-text-tertiary mt-1 leading-snug">
                            Honestly: there are no webhooks here — firing is via polling, so a new PR is seen with
                            ~2 minutes of latency. The poller arrives in a later phase; the trigger is saved today
                            and activates when it lands. Requires a codebase target.
                          </span>
                        )}
                      </span>
                    </label>
                  </div>
                )}
              </FormField>
            </div>
          )}

          {/* ── Step 5 — Review & launch ── */}
          {step === 5 && (
            <div>
              <div className="mb-3 px-3.5 py-3 rounded-md border border-border bg-surface-hover/40">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary mb-2">
                  {step1.name.trim() || 'Unnamed bot'}
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                  <span className="text-text-tertiary">Template</span>
                  <span className="text-text-primary">{step1.template ?? '—'}</span>
                  <span className="text-text-tertiary">Target</span>
                  <span className={`text-text-primary ${step2.targetKind === 'codebase' ? 'font-mono' : ''}`}>{targetLabel}</span>
                  <span className="text-text-tertiary">Model</span>
                  <span className="text-text-primary">{modelLabel}</span>
                  <span className="text-text-tertiary">Trigger</span>
                  <span className="text-text-primary">
                    {step4.trigger === 'cron' ? `cron: ${step4.cronExpr}` : step4.trigger === 'pr_watch' ? 'on new PRs (stored now, activates with the PR poller)' : 'manual'}
                  </span>
                  <span className="text-text-tertiary">Budgets</span>
                  <span className="text-text-primary">
                    {step3.budgetPerRunUsd.trim() ? `$${Number(step3.budgetPerRunUsd).toFixed(2)}/run` : 'no per-run cap'}
                    {' · '}
                    {step3.budgetPerDayUsd.trim() ? `$${Number(step3.budgetPerDayUsd).toFixed(2)}/day` : 'no daily cap'}
                    {' · '}max {step3.maxRunsPerDay}/day
                  </span>
                  <span className="text-text-tertiary">Review</span>
                  <span className="text-text-primary">{step3.requiresReview ? 'human approval required' : 'auto — gates still apply'}</span>
                </div>
                <div className="mt-2.5 text-[12px] text-text-secondary leading-snug border-t border-border pt-2 whitespace-pre-wrap">
                  {step1.prompt.trim()}
                </div>
              </div>

              {/* Estimate panel — ranges only, basis always stated. */}
              <div className="px-3.5 py-2.5 rounded-md border border-border text-[12px]">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">What a run costs</div>
                {estimateLoading ? (
                  <span className="text-text-tertiary">estimating…</span>
                ) : estimateError ? (
                  <span className="text-text-tertiary">No estimate available ({estimateError}).</span>
                ) : estimate ? (
                  <span className="text-text-primary">
                    {estimate.basis === 'prior' ? (
                      <>No history yet — prior for this model tier, wide range: ${estimate.costUsdP25.toFixed(2)}–${estimate.costUsdP75.toFixed(2)} · {Math.round(estimate.minutesP25)}–{Math.round(estimate.minutesP75)} min</>
                    ) : (
                      <>
                        Similar runs: ${estimate.costUsdP25.toFixed(2)}–${estimate.costUsdP75.toFixed(2)} · {Math.round(estimate.minutesP25)}–{Math.round(estimate.minutesP75)} min
                        {' · '}based on {estimate.sampleCount} {estimate.sampleCount === 1 ? 'run' : 'runs'}{' '}
                        {estimate.basis === 'repo' ? 'on this repo' : 'with this model'}
                      </>
                    )}
                  </span>
                ) : (
                  <span className="text-text-tertiary">—</span>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {submitError && (
        <div
          style={{
            margin: '10px 0',
            padding: '8px 12px',
            background: 'var(--color-danger-bg)',
            border: '1px solid var(--color-danger-border)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--color-danger)',
          }}
        >
          {submitError}
        </div>
      )}
    </Modal>
  );
}

export default BotCreateWizard;
