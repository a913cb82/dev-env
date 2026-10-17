# Executed for interactive bash shells via the loader line bootstrap.sh
# appends to ~/.bashrc. Only PATH additions live here; toolchains install
# via apt (see ../apt-requirements.txt). Runtimes deliberately minimal:
# this env needs Python — not nvm, cargo, or Go.
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

# drop duplicate PATH entries, keeping the first occurrence
path_dedupe() {
    local p out=""
    local IFS=:
    for p in $PATH; do
        [ -n "$p" ] || continue
        case ":$out:" in
            *":$p:"*) ;;
            *) out="${out:+$out:}$p" ;;
        esac
    done
    PATH="$out"
    export PATH
}
path_dedupe
