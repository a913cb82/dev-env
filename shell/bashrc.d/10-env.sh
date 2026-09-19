# Executed for interactive bash shells via the loader line bootstrap.sh
# appends to ~/.bashrc. Only PATH additions live here; toolchains install
# via apt (see ../apt-requirements.txt). Runtimes deliberately minimal:
# this env needs Python — not nvm, cargo, or Go.
export PATH="$HOME/.local/bin:$PATH"
