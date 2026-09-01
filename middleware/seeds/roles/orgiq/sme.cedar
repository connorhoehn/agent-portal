// SME: subject-matter expert attached to initiatives. Everything a member can
// do, plus dispatching agent work — an SME spends the budget envelope a
// release manager granted them by assigning compute (bots, marketplace runs)
// to work items on their initiatives. They do not manage budgets, bots'
// standing missions, or any admin surface.
// Scoped to the orgiq tenant.
permit (
  principal,
  action in [
    OrgIQ::Action::"Search",
    OrgIQ::Action::"ViewOrgChart",
    OrgIQ::Action::"ViewObservability",
    OrgIQ::Action::"LabelFeedback",
    // The point of the role: assign computers to do the work.
    OrgIQ::Action::"DispatchAgentRun",
    // Reaching the Computers surface at all. Role-wide, like ManageSprints and
    // for the same reason: Cedar answers "may an SME ever use a computer", and
    // the route layer (lib/devbox-visibility.ts) then answers "which ones" —
    // their own, plus the ones shared on initiatives they own or contribute
    // to. Without this the role could dispatch agent runs but never open the
    // shell those runs happen in, which is the contradiction this grant
    // removes.
    OrgIQ::Action::"ManageDevbox",
    // Sprints have a steward — the SME accountable for that iteration creates
    // it and moves work into it. Cedar grants the capability role-wide; the
    // route layer (routes/sprints.ts requireInitiativeSteward) then scopes an
    // SME's writes to initiatives they own or contribute to, so an SME cannot
    // create/move sprints on an initiative they have nothing to do with.
    OrgIQ::Action::"ManageSprints",
    // Reaching an environment. This is the role the environments domain exists
    // for: an SME spans several initiatives and is the person who has to get
    // into a cluster from a devbox and run a command against it. Every tier —
    // an SME who can only reach dev cannot do the job they are on call for.
    //
    // The grant is reachability only. Getting in still means assuming the
    // environment's access_role_arn, and IAM decides what that role may do.
    OrgIQ::Action::"EnterEnvironment"
  ],
  resource
)
when { principal.role == "sme" && principal has tenant && principal.tenant == "orgiq" };

// A retired environment is not reachable. It is recorded so a postmortem can
// ask where something used to run, not so somebody can shell into it.
//
// This is the attribute escape hatch in use: the environment's properties ride
// on the singleton resource (lib/authz.ts environmentAttrs), the same mechanism
// ApproveTransaction uses for `resource.amount > 10000`. A check that carries
// no attributes — the portal's capability probe, asking "could this role ever
// reach an environment" — does not match, and stays allowed.
forbid (
  principal,
  action == OrgIQ::Action::"EnterEnvironment",
  resource
)
when { principal.role == "sme" && resource has envStatus && resource.envStatus == "retired" };

// SMEs spend inside a granted envelope; they never approve transactions.
// Explicit forbid wins under Cedar evaluation.
forbid (
  principal,
  action == OrgIQ::Action::"ApproveTransaction",
  resource
)
when { principal.role == "sme" };
