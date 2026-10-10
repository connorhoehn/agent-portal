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
import {
  Banner,
  Button,
  Card,
  CatalogGrid,
  Checkbox,
  Chip,
  FilterChip,
  FormField,
  Inline,
  Input,
  MetaLine,
  SectionLabel,
  Modal,
  RadioGroup,
  Select,
  SelectableCard,
  Stack,
  Table,
  TableBody,
  TableRow,
  TableTd,
  Textarea,
  WorkflowStepper,
  type WorkflowStep,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { BOT_STARTERS, type BotStarter } from './botTemplates';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { DEVBOX_MODELS, DEFAULT_DEVBOX_MODEL } from '../../lib/devboxModels';
import {
  budgetsSummaryText,
  estimateSummaryText,
  inputWiring,
  resolveModelLabel,
  resolveTargetLabel,
  reviewTriggerText,
  type Estimate,
} from './botsFormat';
import {
  CRON_PRESETS,
  STEP_LABELS,
  TEMPLATES,
  validateStep1,
  validateStep2,
  validateStep3,
  validateStep4,
  type Step1Errors,
  type Step1State,
  type Step2Errors,
  type Step2State,
  type Step3Errors,
  type Step3State,
  type Step4Errors,
  type Step4State,
} from './botWizardLogic';
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

// ─── Wizard ──────────────────────────────────────────────────────────────────

export function BotCreateWizard({ open, onClose }: BotCreateWizardProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);

  const [step1, setStep1] = useState<Step1State>({ name: '', template: null, prompt: '' });
  const [step2, setStep2] = useState<Step2State>({ targetKind: 'codebase', agentProjectId: '', orgProjectId: '' });
  const [step3, setStep3] = useState<Step3State>({
    model: DEFAULT_DEVBOX_MODEL, budgetPerRunUsd: '', budgetPerDayUsd: '', maxRunsPerDay: 4, requiresReview: true,
  });
  const [step4, setStep4] = useState<Step4State>({ trigger: 'manual', cronExpr: '' });

  // Which predefined starter seeded the form (display state only — the form
  // fields are the source of truth once edited).
  const [starterId, setStarterId] = useState<string | null>(null);

  function applyStarter(t: BotStarter) {
    setStarterId(t.id);
    setStep1({ name: t.label, template: t.template, prompt: t.mission });
    setStep3((prev) => ({
      ...prev,
      budgetPerRunUsd: String(t.budgetPerRunUsd),
      budgetPerDayUsd: String(t.budgetPerDayUsd),
      maxRunsPerDay: t.maxRunsPerDay,
    }));
    setStep4({ trigger: t.trigger, cronExpr: t.cronExpr ?? '' });
    setStep1Touched(new Set());
  }

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
        setStarterId(null);
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
    const res = await writeJson<{ bot?: Bot; error?: string; message?: string }>('/api/bots', 'POST', {
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
    });
    if (res.status !== 201 || !res.data?.bot) {
      setSubmitError(res.data?.error ?? res.data?.message ?? res.error ?? `HTTP ${res.status}`);
      setSubmitting(false);
      return;
    }
    setCreatedBot(res.data.bot);
    setSubmitting(false);
  }

  function openDetail(bot: Bot) {
    onClose();
    navigate(`/admin/bots/${bot.id}`);
  }

  async function runNowAndOpen() {
    const bot = createdBot;
    if (!bot) return;
    setSubmitting(true);
    const res = await writeJson<{ error?: string }>(`/api/bots/${bot.id}/run`, 'POST', {});
    if (res.status === 409) toastError(null, 'Not run', res.data?.error ?? 'The bot refused this run.');
    else if (!res.ok) toastError(null, 'Could not start', res.error ?? `HTTP ${res.status}`);
    else toastSuccess(null, 'First run started', 'It streams on the bot page as it works.');
    setSubmitting(false);
    openDetail(bot);
  }

  // ── Small shared bits ───────────────────────────────────────────────────────

  const targetLabel = resolveTargetLabel({
    targetKind: step2.targetKind,
    agentProjectId: step2.agentProjectId,
    orgProjectId: step2.orgProjectId,
    projects,
    orgProjects: orgProjects ?? [],
  });
  const modelLabel = resolveModelLabel(step3.model, models);

  const stepperSteps: WorkflowStep[] = STEP_LABELS.map((label, i) => ({
    step: i + 1, label, done: i + 1 < step, active: i + 1 === step,
  }));

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
      // maxWidth alone doesn't constrain the library card (and its default is
      // hard-coded white) — cardStyle merges over the card container, so
      // this is what actually makes the modal ~560px and theme-correct.
      cardStyle={{ maxWidth: 560, width: '100%', background: 'var(--color-surface)' }}
      footer={footer}
    >
      <WorkflowStepper steps={stepperSteps} size="sm" />

      {createdBot ? (
        <Stack gap="sm" className="mt-3">
          <Stack gap="none">
            <strong className="text-text-primary">{createdBot.name}</strong> is created
            {step4.trigger === 'cron' ? ` and will fire on ${step4.cronExpr}` : ''}
            {step4.trigger === 'pr_watch' ? ' — the PR trigger is stored and activates with the PR poller' : ''}.
          </Stack>
          <Stack gap="none">
            Fire the first run now to watch it work live, or open the bot page — every change it makes
            still lands in the Changes review queue.
          </Stack>
        </Stack>
      ) : (
        <Stack gap="md" className="mt-3">
          {/* ── Step 1 — Template & mission ── */}
          {step === 1 && (
            <>
              {/* Predefined starters — the mundane-work automations (PR
                  analysis, dependency watch, loop crons) prefilled so an SME
                  or program owner ships one in a minute. Everything below
                  stays editable; a starter is a head start, not a lock. */}
              <FormField
                label="Start from a predefined bot"
                hint="Prefills the mission, trigger and budgets — edit anything before launch."
              >
                {() => (
                  <CatalogGrid columns={3} dense>
                    {BOT_STARTERS.map((t) => {
                      const active = starterId === t.id;
                      return (
                        <SelectableCard key={t.id} selected={active} onSelect={() => applyStarter(t)} padding="sm" className="text-left">
                          <Stack gap="xs">
                            <Inline as="span" gap="none" className={active ? 'text-primary' : 'text-text-primary'}>
                              {t.label}
                            </Inline>
                            <MetaLine size="xs" tone="tertiary" items={[t.blurb]} />
                          </Stack>
                        </SelectableCard>
                      );
                    })}
                  </CatalogGrid>
                )}
              </FormField>

              <FormField label="Name" required error={step1Touched.has('name') ? step1Errors.name : undefined}>
                {(wiring) => (
                  <Input
                    {...inputWiring(wiring)}
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
                  <CatalogGrid columns={3} dense>
                    {TEMPLATES.map((t) => {
                      const active = step1.template === t.id;
                      return (
                        <SelectableCard
                          key={t.id}
                          selected={active}
                          padding="sm"
                          className="text-left"
                          onSelect={() => {
                            setStep1((prev) => ({ ...prev, template: t.id }));
                            setStep1Touched((prev) => new Set([...prev, 'template']));
                          }}
                        >
                          <Stack gap="xs">
                            <Inline as="span" gap="none" className={active ? 'text-primary' : 'text-text-primary'}>
                              {t.label}
                            </Inline>
                            <MetaLine size="xs" tone="tertiary" items={[t.blurb]} />
                          </Stack>
                        </SelectableCard>
                      );
                    })}
                  </CatalogGrid>
                )}
              </FormField>

              <FormField
                label="The mission"
                required
                error={step1Touched.has('prompt') ? step1Errors.prompt : undefined}
                hint="What should this bot do? Written, not picked."
              >
                {(wiring) => (
                  <Textarea
                    {...inputWiring(wiring)}
                    minRows={5}
                    autoResize
                    value={step1.prompt}
                    onChange={(e) => setStep1((prev) => ({ ...prev, prompt: e.target.value }))}
                    onBlur={() => setStep1Touched((prev) => new Set([...prev, 'prompt']))}
                    placeholder="e.g. Hunt down dead code and unused dependencies. Prefer many small, reviewable changes over one sweeping one. Never touch generated files."
                  />
                )}
              </FormField>
            </>
          )}

          {/* ── Step 2 — Target ── */}
          {step === 2 && (
            <>
              <FormField
                label="What does it work on?"
                required
                error={step2Touched.has('target') ? step2Errors.target : undefined}
              >
                {() => (
                  <Stack gap="sm">
                    <RadioGroup
                      name="bot-target-kind"
                      value={step2.targetKind}
                      onChange={(v) => setStep2((prev) => ({ ...prev, targetKind: v }))}
                      options={[
                        { value: 'codebase', label: 'Codebase', description: 'a linked repository the bot changes directly' },
                        { value: 'initiative', label: 'Initiative', description: 'an org initiative the bot serves' },
                      ]}
                    />
                    {step2.targetKind === 'codebase' ? (
                      <Stack gap="xs">
                        <Select
                          value={step2.agentProjectId}
                          onChange={(e) => {
                            setStep2((prev) => ({ ...prev, agentProjectId: e.target.value }));
                            setStep2Touched((prev) => new Set([...prev, 'target']));
                          }}
                          placeholder="— pick a codebase —"
                          options={projects.map((p) => ({
                            value: p.id,
                            label: `${p.repoFullName}${p.orgProjectName ? ` · ${p.orgProjectName}` : ''}`,
                          }))}
                        />
                        {projects.length === 0 && (
                          <MetaLine size="xs" tone="tertiary" items={['No codebases linked yet — link a repository in Codebases first.']} />
                        )}
                      </Stack>
                    ) : (
                      <Select
                        value={step2.orgProjectId}
                        onChange={(e) => {
                          setStep2((prev) => ({ ...prev, orgProjectId: e.target.value }));
                          setStep2Touched((prev) => new Set([...prev, 'target']));
                        }}
                        placeholder="— pick an initiative —"
                        options={(orgProjects ?? []).map((op) => ({ value: op.id, label: op.name }))}
                      />
                    )}
                  </Stack>
                )}
              </FormField>
              <MetaLine size="xs" tone="tertiary" items={['The on-new-PRs trigger (step 4) requires a codebase target.']} />
            </>
          )}

          {/* ── Step 3 — Guardrails ── */}
          {step === 3 && (
            <>
              <FormField label="Model" hint={models.find((m) => m.id === step3.model)?.hint}>
                {(wiring) => (
                  <Select
                    {...inputWiring(wiring)}
                    value={step3.model}
                    onChange={(e) => setStep3((prev) => ({ ...prev, model: e.target.value }))}
                    options={models.map((m) => ({ value: m.id, label: m.label }))}
                  />
                )}
              </FormField>

              <FormField
                label="Budget per run ($)"
                error={step3Touched.has('budgetPerRunUsd') ? step3Errors.budgetPerRunUsd : undefined}
                hint="Soft cap — a run that exceeds it is flagged. Empty for none."
              >
                {(wiring) => (
                  <Input
                    {...inputWiring(wiring)}
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
                {(wiring) => (
                  <Input
                    {...inputWiring(wiring)}
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
                {(wiring) => (
                  <Input
                    {...inputWiring(wiring)}
                    type="number" min={1}
                    value={step3.maxRunsPerDay}
                    onChange={(e) => setStep3((prev) => ({ ...prev, maxRunsPerDay: Number(e.target.value) }))}
                    onBlur={() => setStep3Touched((prev) => new Set([...prev, 'maxRunsPerDay']))}
                  />
                )}
              </FormField>

              <Stack gap="xs">
                <Inline gap="sm" align="center">
                  <Checkbox
                    checked={step3.requiresReview}
                    onChange={(checked) => setStep3((prev) => ({ ...prev, requiresReview: checked }))}
                    aria-label="Requires review"
                  />
                  Requires review
                </Inline>
                <MetaLine
                  size="xs" tone="tertiary"
                  items={['Every change still passes independent review and policy gates either way — this adds an explicit human approval.']}
                />
              </Stack>
            </>
          )}

          {/* ── Step 4 — Trigger ── */}
          {step === 4 && (
            <FormField
              label="When does it fire?"
              error={step4Touched.has('trigger') ? step4Errors.trigger : undefined}
            >
              {() => (
                <Stack gap="sm">
                  <RadioGroup
                    name="bot-trigger"
                    value={step4.trigger}
                    onChange={(v) => setStep4((prev) => ({ ...prev, trigger: v }))}
                    options={[
                      { value: 'manual', label: 'Manual', description: 'fires only when you press Run now' },
                      { value: 'cron', label: 'Cron', description: 'on a schedule' },
                      { value: 'pr_watch', label: 'On new PRs', description: 'stored now, activates with the PR poller' },
                    ]}
                  />
                  {step4.trigger === 'cron' && (
                    <FormField
                      label="Cron expression"
                      error={step4Touched.has('cronExpr') ? step4Errors.cronExpr : undefined}
                    >
                      {(wiring) => (
                        <Stack gap="xs">
                          <Inline gap="xs" wrap>
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
                          </Inline>
                          <Input
                            {...inputWiring(wiring)}
                            mono
                            value={step4.cronExpr}
                            onChange={(e) => setStep4((prev) => ({ ...prev, cronExpr: e.target.value }))}
                            onBlur={() => setStep4Touched((prev) => new Set([...prev, 'cronExpr']))}
                            placeholder="0 9 * * *"
                          />
                        </Stack>
                      )}
                    </FormField>
                  )}
                  {step4.trigger === 'pr_watch' && (
                    <Stack gap="xs">
                      <Chip size="xs">stored now, activates with the PR poller</Chip>
                      <MetaLine
                        size="xs" tone="tertiary"
                        items={[
                          'Honestly: there are no webhooks here — firing is via polling, so a new PR is seen with ~2 minutes of latency. The poller arrives in a later phase; the trigger is saved today and activates when it lands. Requires a codebase target.',
                        ]}
                      />
                    </Stack>
                  )}
                </Stack>
              )}
            </FormField>
          )}

          {/* ── Step 5 — Review & launch ── */}
          {step === 5 && (
            <>
              <Card padding="md">
                <SectionLabel as="div" className="mb-2">{step1.name.trim() || 'Unnamed bot'}</SectionLabel>
                <Table size="sm">
                  <TableBody>
                    <TableRow><TableTd className="text-text-tertiary">Template</TableTd><TableTd>{step1.template ?? '—'}</TableTd></TableRow>
                    <TableRow>
                      <TableTd className="text-text-tertiary">Target</TableTd>
                      <TableTd className={step2.targetKind === 'codebase' ? 'font-mono' : ''}>{targetLabel}</TableTd>
                    </TableRow>
                    <TableRow><TableTd className="text-text-tertiary">Model</TableTd><TableTd>{modelLabel}</TableTd></TableRow>
                    <TableRow><TableTd className="text-text-tertiary">Trigger</TableTd><TableTd>{reviewTriggerText(step4)}</TableTd></TableRow>
                    <TableRow>
                      <TableTd className="text-text-tertiary">Budgets</TableTd>
                      <TableTd>{budgetsSummaryText(step3)}</TableTd>
                    </TableRow>
                    <TableRow>
                      <TableTd className="text-text-tertiary">Review</TableTd>
                      <TableTd>{step3.requiresReview ? 'human approval required' : 'auto — gates still apply'}</TableTd>
                    </TableRow>
                  </TableBody>
                </Table>
                <Stack gap="none" className="text-xs mt-2.5 text-text-secondary leading-snug border-t border-border pt-2 whitespace-pre-wrap">
                  {step1.prompt.trim()}
                </Stack>
              </Card>

              {/* Estimate panel — ranges only, basis always stated. */}
              <Card padding="sm">
                <SectionLabel as="div" className="mb-1">What a run costs</SectionLabel>
                <MetaLine
                  size="sm"
                  items={[estimateSummaryText({ loading: estimateLoading, error: estimateError, estimate: estimate ?? null })]}
                />
              </Card>
            </>
          )}
        </Stack>
      )}

      {submitError && (
        <Banner variant="error" className="mt-2.5">{submitError}</Banner>
      )}
    </Modal>
  );
}

export default BotCreateWizard;
