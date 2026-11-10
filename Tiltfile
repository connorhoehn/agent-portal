# Local app stack: middleware (offline mock mode) + portal, as host processes.
# No Docker or AWS needed. `tilt up` then open http://localhost:5183.
# The soak/load stack has its own Tiltfile in scripts/loadtest/.
#
# `social-sim` (label: demo) keeps /social/channels lively: six seeded users
# (u-lena, u-sana, u-asha, u-jonas, u-nora, u-rachel) hold real /ws sessions,
# show up in Active now and channel presence, and post (off-topic, #random only) or react every 15-30 min.
# The ten-day history, mentions and unread items it sits on are mock fixtures
# (middleware/src/mock/core/contract.ts). Demo as u-farah (or u-mira/u-theo/u-vera); do not log
# in as a sim user, the tenant switch would sign the sim out and back in.
# Stop it from the Tilt UI when you want a quiet workspace.

# Real-media env (gitignored JSON, never printed): REALTIME_JWT_SECRET shared
# with platform-api plus the public/internal URLs. Absent file = no media.
# The social compose profile is started with scripts/social-documents.mjs.
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

# SSH forwards into the Colima VM. The key path, user and port come from
# `colima ssh-config` at start, never literals: they differ per machine and the
# port changes whenever the VM restarts. Command-line options override the
# generated config, so these forwards never share Lima's control socket.
def _colima_forward(forwards):
    cfg = '"${TMPDIR:-/tmp}/orgiq-colima-ssh.config"'
    return ' '.join([
        'colima ssh-config > ' + cfg + ' &&',
        'exec ssh -F ' + cfg,
        '-o ControlMaster=no -o ControlPath=none -o BatchMode=yes -o IdentitiesOnly=yes',
        '-o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3',
        '-N', ' '.join(['-L 127.0.0.1:%d:127.0.0.1:%d' % (port, port) for port in forwards]),
        'colima',
    ])

# The platform-api published inside the VM. Separate from the capacity
# forwarder (never touch that one).
local_resource(
    'platform-api-forward',
    serve_cmd=_colima_forward([23002, 16480]),
    labels=['media'],
)

# Document canvas: the labelled social-documents containers in the Colima VM
# (gateway :28080 serves the Yjs socket, platform-api :23001 the comments and
# workflows). Requires `docker start orgiq-social-redis orgiq-social-dynamodb`
# if the VM restarted.
local_resource(
    'social-docs-forward',
    serve_cmd=_colima_forward([28080, 23001]),
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
