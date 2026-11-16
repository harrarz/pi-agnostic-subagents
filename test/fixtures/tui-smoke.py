"""Real Pi PTY E2E. Default: fake children, no provider calls.
python3 test/fixtures/tui-smoke.py
python3 test/fixtures/tui-smoke.py --live  # ONLY with explicit quota/cost approval
"""
import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

REPO = Path(__file__).resolve().parents[2]
NODE = subprocess.check_output(["which", "node"], text=True).strip()


def group_gone(run):
    pid = run.get("processPid")
    if not pid:
        return True
    try:
        os.killpg(pid, 0)
        return False
    except ProcessLookupError:
        return True


class TerminalSession:
    def __init__(self, mode, root, live):
        self.mode = mode
        self.root = Path(root)
        self.config = self.root / "agent" / "agent-supervisor"
        self.config.mkdir(parents=True)
        profiles = {"defaultProfile": "fake", "profiles": {"fake": {
            "executable": NODE,
            "args": [str(REPO / "test/fixtures/fake-agent.mjs"), "--", "{task}"],
            "taskTransport": "argument", "outputProtocol": "pi-jsonl",
        }}}
        profiles["profiles"]["selectable"] = {
            "executable": NODE,
            "args": [str(REPO / "test/fixtures/fake-agent.mjs"), "{modelArgs}", "--", "{task}"],
            "modelArgs": ["--model", "{model}"], "modelFormat": "id",
            "taskTransport": "argument", "outputProtocol": "text",
        }
        profiles["profiles"]["interactive"] = {
            "executable": NODE,
            "args": [str(REPO / "test/fixtures/fake-rpc-agent.mjs"), "--session", "{session}"],
            "taskTransport": "pi-rpc", "outputProtocol": "pi-jsonl",
        }
        self.live_effort = None
        if live:
            # Shared TypeScript helper copies credentials privately; never prints them.
            prepared = subprocess.run([NODE, "--import", "tsx", "--input-type=module", "-e",
                            "import {prepareLivePiConfig} from './test/fixtures/live-config.ts'; console.log(JSON.stringify(await prepareLivePiConfig(process.argv[1])));",
                            str(self.config.parent)], cwd=REPO, check=True, capture_output=True, text=True)
            self.live_effort = json.loads(prepared.stdout).get("effort")
            live_config = json.loads((self.config / "profiles.json").read_text())
            profiles["profiles"]["pi"] = live_config["profiles"]["pi"]
        (self.config / "profiles.json").write_text(json.dumps(profiles))
        # Ask the actual loader for selectable profile identities, including bundled defaults.
        choices = subprocess.run([NODE, "--import", "tsx", "--input-type=module", "-e",
            "import {loadSupervisorConfig} from './src/config.ts'; const c=await loadSupervisorConfig(process.argv[1]); console.log(JSON.stringify(Object.entries(c.profiles).filter(([,p])=>p.modelArgs).map(([name])=>name)));",
            str(self.config / "profiles.json")], cwd=REPO, check=True, capture_output=True, text=True)
        self.model_profiles = json.loads(choices.stdout)
        self.project = self.root / "project"
        self.project.mkdir()
        (self.project / "tui-seed.txt").write_text("terminal proof\n")
        (self.project / "tracked.txt").write_text("committed source\n")
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        subprocess.run(["git", "-C", str(self.project), "add", "--all"], check=True)
        subprocess.run(["git", "-C", str(self.project), "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "seed"], check=True)
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(self.config.parent), PI_OFFLINE="1", PI_TELEMETRY="0", TERM="xterm-256color")
        self.process = subprocess.Popen([
            os.environ.get("PI_BIN", "pi"),
            "--offline", "--no-session", "--no-extensions", "--extension", str(REPO / "src/index.ts"),
            "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tui-mode", mode,
        ], stdin=slave, stdout=slave, stderr=slave, cwd=self.project, env=env, start_new_session=True)
        os.close(slave)
        self.captured = bytearray()

    def pump(self, seconds):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if select.select([self.master], [], [], 0.04)[0]:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                self.captured.extend(chunk)

    def send(self, text):
        os.write(self.master, text.encode())

    def command(self, text):
        self.send(text + "\r")
        self.pump(0.15)

    def select_model_profile(self, name):
        self.send("\x1b[B" * self.model_profiles.index(name) + "\r")
        self.pump(0.15)

    def records(self):
        return [json.loads(path.read_text()) for path in self.config.glob("runtime/runs/*/*.json")]

    def wait_run(self, label, state, seconds=12, turn=None):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            self.pump(0.08)
            match = next((run for run in self.records() if run.get("label") == label and run["state"] == state and (turn is None or run.get("control", {}).get("turn") == turn)), None)
            if match:
                return match
        outcomes = [(run.get("label"), run["state"], run.get("error")) for run in self.records()]
        raise AssertionError(f"{self.mode}: {label} did not reach {state}: {outcomes}")

    def back_to_editor(self):
        self.send("\x1b")
        self.pump(0.15)
        self.send("\x1b")
        self.pump(0.15)

    def stop_from_browser(self, run, cancel_first=False):
        self.command(f'/agent show {run["id"]}')
        self.send("s")
        self.pump(0.15)
        if cancel_first:
            self.send("\x1b")
            self.pump(0.15)
            current = next(item for item in self.records() if item["id"] == run["id"])
            assert current["state"] == run["state"], "Escape must cancel stop confirmation"
            self.send("s")
            self.pump(0.15)
        self.send("y")
        stopped = self.wait_run(run["label"], "cancelled")
        assert group_gone(stopped), "confirmed stop must clean up the process group"
        self.back_to_editor()
        return stopped

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        os.close(self.master)


def smoke(mode, live):
    with tempfile.TemporaryDirectory(prefix="pi-supervisor-tui-") as root:
        terminal = TerminalSession(mode, root, live)
        try:
            # Wait for session initialization instead of racing a fixed startup sleep.
            ready_by = time.monotonic() + 20
            while not list(terminal.config.glob("runtime/runs/*")) and time.monotonic() < ready_by:
                terminal.pump(0.1)
                assert terminal.process.poll() is None, "Pi exited during startup"
            assert list(terminal.config.glob("runtime/runs/*")), "supervisor session did not initialize"
            terminal.pump(0.5)
            terminal.command("/agent")
            terminal.pump(0.15)
            assert "No agents." in terminal.captured.decode("utf-8", errors="replace"), "loading should not spawn work"
            terminal.send("\x1b")
            terminal.pump(0.15)
            task = "Read tui-seed.txt and reply exactly LIVE_TUI_OK. Do not edit anything or perform other work." if live else json.dumps({"mode": "pi-output", "ms": 1500})
            profile = ("--profile pi" + (f" --effort {terminal.live_effort}" if terminal.live_effort else "")) if live else "--profile fake"
            terminal.command(f"/agent run --label auth-check {profile} -- {task}")
            terminal.command("/agent")
            terminal.send("\r")
            completed = terminal.wait_run("auth-check", "exited", seconds=130 if live else 12)
            expected = "LIVE_TUI_OK" if live else "Clean final answer 雪"
            assert completed.get("presentation", {}).get("finalAnswer") == expected
            assert group_gone(completed)
            # The automatic widget expires, but an explicitly opened answer stays.
            terminal.pump(3.2)
            before_transcript = len(terminal.captured)
            terminal.send("t")
            terminal.pump(0.3)
            assert "Transcript" in terminal.captured[before_transcript:].decode("utf-8", errors="replace"), "completion expiry must not close manual inspection"
            fcntl.ioctl(terminal.master, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 60, 0, 0))
            os.kill(terminal.process.pid, signal.SIGWINCH)
            terminal.pump(0.3)
            before_diagnostics = terminal.captured.decode("utf-8", errors="replace")
            assert "HIDDEN REASONING" not in before_diagnostics
            assert "FORGED STDERR ANSWER" not in before_diagnostics
            terminal.send("d")  # Raw logs must be reachable only on explicit inspection.
            terminal.pump(0.3)
            # Long live prompts wrap to more metadata rows than fake JSON tasks.
            # Scroll one row at a time so the log heading cannot be skipped.
            for _ in range(100):
                if "Combined log:" in terminal.captured.decode("utf-8", errors="replace"):
                    break
                terminal.send("\x1b[B")
                terminal.pump(0.08)
            assert "Combined log:" in terminal.captured.decode("utf-8", errors="replace")
            terminal.send("\x1b[F")  # End: expose the bottom of the diagnostic snapshot.
            terminal.pump(0.15)
            terminal.back_to_editor()
            # Resize forces a fresh editor repaint, not a search through old scrollback.
            after_expiry = len(terminal.captured)
            fcntl.ioctl(terminal.master, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 61, 0, 0))
            os.kill(terminal.process.pid, signal.SIGWINCH)
            terminal.pump(0.3)
            assert "Agents ·" not in terminal.captured[after_expiry:].decode("utf-8", errors="replace"), "idle widget must return its rows to the editor"

            # Real keyboard actions over a bidirectional child, with no provider.
            terminal.command('/agent run --label guided --profile interactive -- {"delayMs":60000}')
            terminal.wait_run("guided", "running")
            terminal.command("/agent")
            terminal.pump(0.2)
            assert "╭" in terminal.captured.decode("utf-8", errors="replace")
            terminal.send("\x1b[C\r")  # Inspect -> Steer -> native message editor
            terminal.pump(0.2)
            terminal.send("PTY_STEER_MARKER\r")
            guided = terminal.wait_run("guided", "exited", turn=1)
            assert "PTY_STEER_MARKER" in guided["presentation"]["finalAnswer"]
            terminal.pump(0.3)
            terminal.send("\x1b[C\r")  # Inspect -> Follow up
            terminal.pump(0.2)
            terminal.send("PTY_FOLLOW_MARKER\r")
            continued = terminal.wait_run("guided", "exited", turn=2)
            assert "PTY_STEER_MARKER" in continued["presentation"]["finalAnswer"]
            assert "PTY_FOLLOW_MARKER" in continued["presentation"]["finalAnswer"]
            terminal.pump(0.2)
            terminal.send("\x1b")  # Answer -> list
            terminal.pump(0.15)
            prior_ids = {run["id"] for run in terminal.records()}
            terminal.send("\x1b[C\x1b[C\r")  # Inspect -> Follow up -> Rerun
            terminal.pump(0.2)
            terminal.send("\r")  # Confirm fresh run
            until = time.monotonic() + 12
            fresh = None
            while time.monotonic() < until:
                terminal.pump(0.08)
                fresh = next((run for run in terminal.records() if run["id"] not in prior_ids and run["state"] == "exited"), None)
                if fresh:
                    break
            assert fresh, "inline Rerun must create a fresh run"
            assert fresh["control"]["turn"] == 1
            assert fresh["control"]["sessionPath"] != guided["control"]["sessionPath"]
            assert fresh["presentation"]["finalAnswer"] == "PTY_FOLLOW_MARKER"
            terminal.pump(0.2)
            terminal.send("\x1b")  # Answer -> list
            terminal.pump(0.15)
            count = len(terminal.records())
            terminal.send("\x1b[C\x1b[C\x1b[C\r")  # Rerun with changes
            terminal.pump(0.2)
            terminal.send("\x1b")  # Cancel form; no run
            terminal.pump(0.2)
            assert len(terminal.records()) == count
            terminal.send("\x1b")  # Close reopened browser
            terminal.pump(0.2)

            # Settings UI persists a user choice; explicit run overrides still win.
            terminal.command("/agent settings")
            terminal.select_model_profile("selectable")
            terminal.send("\x1b[B\x1b[B\r")  # Enter exact model ID
            terminal.pump(0.15)
            terminal.send("test-model-a\r")
            terminal.pump(0.2)
            terminal.send("\x1b")  # close settings profile list
            terminal.pump(0.15)
            preferences = json.loads((terminal.config / "settings.json").read_text())
            assert preferences["models"]["selectable"] == "test-model-a"
            terminal.command("/agent run --label saved-model --profile selectable -- settings proof")
            saved = terminal.wait_run("saved-model", "exited")
            assert saved["model"] == "test-model-a"
            terminal.command("/agent run --label explicit-model --profile selectable --model test-model-b -- override proof")
            explicit = terminal.wait_run("explicit-model", "exited")
            assert explicit["model"] == "test-model-b"
            terminal.command("/agent config")  # settings alias
            terminal.select_model_profile("selectable")
            terminal.send("\r")  # Follow parent
            terminal.pump(0.2)
            terminal.send("\x1b")
            terminal.pump(0.15)
            assert "selectable" not in json.loads((terminal.config / "settings.json").read_text())["models"]

            # Restore room, then exercise real keyboard actions and durable process state.
            fcntl.ioctl(terminal.master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
            os.kill(terminal.process.pid, signal.SIGWINCH)
            # Worktree writers in the same source repository must overlap.
            terminal.command('/agent run --label tree-one --profile fake --isolation worktree -- {"mode":"workspace","text":"one","ms":60000}')
            tree_one = terminal.wait_run("tree-one", "running")
            terminal.command('/agent run --label tree-two --profile fake --isolation worktree -- {"mode":"workspace","text":"two","ms":60000}')
            tree_two = terminal.wait_run("tree-two", "running")
            assert next(run for run in terminal.records() if run["label"] == "tree-one")["state"] == "running"
            assert tree_one["cwd"] != tree_two["cwd"]
            before_detail = len(terminal.captured)
            terminal.command(f'/agent show {tree_one["id"]}')
            terminal.pump(0.2)
            assert "Worktree:" in terminal.captured[before_detail:].decode("utf-8", errors="replace")
            terminal.back_to_editor()
            terminal.stop_from_browser(tree_one)
            terminal.stop_from_browser(tree_two)
            for tree, expected_text in [(tree_one, "one"), (tree_two, "two")]:
                assert (Path(tree["cwd"]) / "work.txt").read_text() == expected_text
                assert next(run for run in terminal.records() if run["id"] == tree["id"])["worktree"]["state"] == "retained"
            assert not (terminal.project / "work.txt").exists()
            (Path(tree_one["cwd"]) / "work.txt").unlink()
            terminal.command(f'/agent worktree remove {tree_one["id"]}')
            terminal.send("\r")  # Native human confirmation: Yes.
            terminal.pump(0.4)
            assert not Path(tree_one["cwd"]).exists()
            assert Path(tree_two["cwd"]).exists(), "cleanup must not remove a sibling worktree"

            terminal.command('/agent run --label cancel-me --profile fake -- {"mode":"sleep","ms":60000}')
            running = terminal.wait_run("cancel-me", "running")
            terminal.command('/agent run --label shared-peer --profile fake -- {"mode":"sleep","ms":60000}')
            peer = terminal.wait_run("shared-peer", "running")
            assert next(run for run in terminal.records() if run["id"] == running["id"])["state"] == "running"
            assert running["cwd"] == peer["cwd"], "shared-folder writers must overlap by default"
            terminal.command('/agent run --label third-writer --profile fake -- {"mode":"sleep","ms":60000}')
            third = terminal.wait_run("third-writer", "running")
            assert all(next(item for item in terminal.records() if item["id"] == run["id"])["state"] == "running" for run in [running, peer, third]), "all three agents must run without a scheduler queue"
            terminal.command("/agent")
            terminal.pump(0.3)
            terminal.back_to_editor()
            stopped_third = terminal.stop_from_browser(third)
            assert stopped_third.get("processPid"), "the third agent must have launched instead of waiting for capacity"
            terminal.stop_from_browser(running, cancel_first=True)
            assert next(run for run in terminal.records() if run["id"] == peer["id"])["state"] == "running"
            terminal.stop_from_browser(peer)

            terminal.command('/agent run --label deadline --profile fake --timeout-ms 300 -- {"mode":"sleep","ms":60000}')
            timed_out = terminal.wait_run("deadline", "timed_out")
            assert group_gone(timed_out), "timeout must clean up the process group"
            count = len(terminal.records())
            terminal.command("/agent run --profile missing-profile -- Must not launch")
            assert len(terminal.records()) == count, "invalid profile must not admit work"

            terminal.command('/agent run --label reload-me --profile fake -- {"mode":"sleep","ms":60000}')
            terminal.wait_run("reload-me", "running")
            terminal.command("/reload")
            reloaded = terminal.wait_run("reload-me", "cancelled")
            assert group_gone(reloaded), "reload must stop owned children"
            terminal.pump(0.5)
            terminal.command("/agent")
            terminal.pump(0.3)
            terminal.back_to_editor()
            terminal.command('/agent run --label quit-me --profile fake -- {"mode":"sleep","ms":60000}')
            terminal.wait_run("quit-me", "running")
            terminal.send("\x04")
            stopped_on_quit = terminal.wait_run("quit-me", "cancelled")
            assert group_gone(stopped_on_quit), "quitting Pi must stop owned children"
            terminal.process.wait(timeout=5)
            assert terminal.process.returncode == 0
            text = terminal.captured.decode("utf-8", errors="replace")
            for required in ["auth-check", "Final answer", expected, "Transcript", "Agents · 3 active", "timed out", "Stop selected agent"]:
                assert required in text, f"{mode}: missing {required!r} in terminal capture"
            for forbidden in ["TypeError", "Extension Error", "Concurrency limit", "CAPACITY_FULL"]:
                assert forbidden not in text, f"{mode}: leaked {forbidden!r}"
            assert all(group_gone(run) for run in terminal.records()), "no owned process groups may remain"
            print(f"{mode}: {'LIVE Pi child' if live else 'fake child'}; borders/inline steer/follow-up/rerun/cancel, status/answer/transcript/resize/idle-dismissal/manual-view retention, model settings/save/override/clear, parallel shared writers/worktrees/retention/cleanup, unrestricted shared launches, cancelled confirmation, starting/running stop, timeout, invalid profile, reload and quit cleanup passed")
        except Exception:
            Path(f"/tmp/pi-supervisor-tui-{mode}.log").write_bytes(terminal.captured)
            raise
        finally:
            terminal.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="Use existing credentials for one tiny real Pi task per TUI mode; consumes quota")
    args = parser.parse_args()
    for tui_mode in ["regular", "fullscreen"]:
        smoke(tui_mode, args.live)
