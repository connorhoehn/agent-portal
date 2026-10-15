# Local app stack: middleware (offline mock mode) + portal, as host processes.
# No Docker or AWS needed. `tilt up` then open http://localhost:5183.
# The soak/load stack has its own Tiltfile in scripts/loadtest/.
#
# `social-sim` (label: demo) keeps /social/channels lively: six seeded users
# (u-lena, u-sana, u-asha, u-jonas, u-nora, u-rachel) hold real /ws sessions,
# show up in Active now and channel presence, and post (off-topic, #random only) or react every 15-30 min.
# The ten-day history, mentions and unread items it sits on are mock fixtures
# (docs/mock-floor.md). Demo as u-farah (or u-mira/u-theo/u-vera); do not log
# in as a sim user, the tenant switch would sign the sim out and back in.
# Stop it from the Tilt UI when you want a quiet workspace.

# Real-media env (gitignored JSON, never printed): REALTIME_JWT_SECRET shared
# with platform-api plus the public/internal URLs. Absent file = no media.
# See docs/social-calls-first-call.md "Tilt stack".
_media_env = {}
if os.path.exists('middleware/.env.tilt.local'):
    _media_env = read_json('middleware/.env.tilt.local')
    watch_file('middleware/.env.tilt.local')

_mw_env = {
    'PORT': '3001',
    'LOGIN_RATE_LIMIT_PER_MIN': '120',  # dev-only: shared 127.0.0.1 bucket across walks + e2e
    # The one-time Aurora→platform-api comment import the documents-parity
    # comments journey needs (what `dev:mock:social` sets); the social
    # profile's DynamoDB Local publishes :8000. Chat stays on the memory store.
    'DOCUMENT_COMMENT_IMPORT_TABLE': 'document-comments',
    'DOCUMENT_COMMENT_IMPORT_DYNAMODB_ENDPOINT': 'http://127.0.0.1:8000',
}
_mw_env.update(_media_env)

# SSH forward to the platform-api published inside the Colima VM. Separate from
# the capacity forwarder (never touch that one); same key/options.
local_resource(
    'platform-api-forward',
    serve_cmd=' '.join([
        'exec ssh -F /dev/null -i /Users/connorhoehn/.colima/_lima/_config/user',
        '-o ControlMaster=no -o ControlPath=none -o BatchMode=yes -o IdentitiesOnly=yes',
        '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
        '-o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3',
        '-p 50697 -N -L 127.0.0.1:23002:127.0.0.1:23002 -L 127.0.0.1:16480:127.0.0.1:16480 connorhoehn@127.0.0.1',
    ]),
    labels=['media'],
)

# Document canvas: the labelled social-documents containers in the Colima VM
# (gateway :28080 serves the Yjs socket, platform-api :23001 the comments and
# workflows). Same key/options as platform-api-forward. Requires
# `docker start orgiq-social-redis orgiq-social-dynamodb` if the VM restarted.
local_resource(
    'social-docs-forward',
    serve_cmd=' '.join([
        'exec ssh -F /dev/null -i /Users/connorhoehn/.colima/_lima/_config/user',
        '-o ControlMaster=no -o ControlPath=none -o BatchMode=yes -o IdentitiesOnly=yes',
        '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
        '-o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3',
        '-p 50697 -N -L 127.0.0.1:28080:127.0.0.1:28080 -L 127.0.0.1:23001:127.0.0.1:23001 connorhoehn@127.0.0.1',
    ]),
    labels=['media'],
)

local_resource(
    'middleware',
    serve_cmd='npm run dev:mock',
    serve_dir='middleware',
    serve_env=_mw_env,
    readiness_probe=probe(http_get=http_get_action(port=3001, path='/api/health'), period_secs=3),
    links=[link('http://localhost:3001/api/health', 'health')],
    labels=['app'],
)

local_resource(
    'portal',
    serve_cmd='npm run dev',
    serve_dir='portal',
    resource_deps=['middleware'],
    readiness_probe=probe(http_get=http_get_action(port=5183, path='/'), period_secs=3),
    links=[link('http://localhost:5183', 'portal')],
    labels=['app'],
)

local_resource(
    'social-sim',
    serve_cmd='node scripts/dev/social-sim.mjs',
    resource_deps=['middleware'],
    labels=['demo'],
)
