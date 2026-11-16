"""Linux regression fixture: retain an exited child until this parent stops."""
import os
import signal

child = os.fork()
if child == 0:
    os._exit(0)
print(child, flush=True)
signal.pause()
