PACKAGE_NAME = cockpit-openshift-overview
VERSION = 0.1.0
DESTDIR ?=
PREFIX ?= /usr/local

install:
	mkdir -p $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)
	cp manifest.json index.html app.js style.css $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)/

rpm:
	rpmbuild -bb $(PACKAGE_NAME).spec \
		--define "_sourcedir $(PWD)" \
		--define "_specdir $(PWD)" \
		--define "_builddir $(PWD)" \
		--define "_rpmdir $(PWD)"

clean:
	rm -rf *.rpm noarch/
