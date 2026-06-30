NAME=thunderbird-tray
DOMAIN=domgregori.github.com

.PHONY: all pack errortest install installfromzip uninstall debug upload clean cleanall

all: dist/extension.js

node_modules: package.json
	npm install

dist/extension.js: node_modules
	@(tsc || { echo "typescript not installed" >&2; exit 1; })

$(NAME).zip: dist/extension.js
	@cp metadata.json dist/
	@(cd dist && zip ../$(NAME).zip -9r .)

pack: $(NAME).zip

errortest: pack
	uvx shexli $(NAME).zip

install: $(NAME).zip
	@touch ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@rm -rf ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@mv dist ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)

installfromzip: $(NAME).zip
	@gnome-extensions install $(NAME).zip --force
	@gnome-extensions enable $(NAME)@$(DOMAIN)

uninstall:
	gnome-extensions uninstall $(NAME)@$(DOMAIN)

debug: $(NAME).zip install
	@([ -f /usr/lib/mutter-devkit ] || { echo "mutter-devkit not installed" >&2; exit 1; })
	GSETTINGS_BACKEND=memory dbus-run-session -- gnome-shell --devkit 'gnome-shell-test-tool --extension $(NAME).zip dist/extension.js'

upload: $(NAME).zip
	gnome-extensions upload --accept-tos -u domgregori $(NAME).zip

clean:
	@rm -rf dist $(NAME).zip

cleanall:
	@rm -rf dist node_modules $(NAME).zip
