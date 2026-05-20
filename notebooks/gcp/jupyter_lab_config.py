c = get_config()  # noqa

c.ServerApp.ip = '0.0.0.0'
c.ServerApp.port = 8888
c.ServerApp.open_browser = False
c.ServerApp.allow_root = True
c.ServerApp.token = ''
c.ServerApp.password = ''
c.ServerApp.allow_origin = '*'
c.ServerApp.root_dir = '/workspace'
c.LabApp.default_url = '/lab'
c.LabServerApp.collaborative = False
