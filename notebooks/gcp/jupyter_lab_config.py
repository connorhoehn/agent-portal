c = get_config()  # noqa

c.ServerApp.ip = '0.0.0.0'
c.ServerApp.port = 8888
c.ServerApp.open_browser = False
c.ServerApp.allow_root = True
# Keep Jupyter token authentication and same-origin protections enabled.
c.ServerApp.root_dir = '/workspace'
c.LabApp.default_url = '/lab'
c.LabServerApp.collaborative = False
