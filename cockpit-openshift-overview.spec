Name:           cockpit-openshift-overview
Version:        0.1.3
Release:        1%{?dist}
Summary:        Cockpit plugin for OpenShift cluster overview

License:        MIT
URL:            https://github.com/samjage/cockpit-openshift-overview
Source0:        %{name}-%{version}.tar.gz

BuildArch:      noarch
Requires:       cockpit >= 286

%description
A Cockpit plugin providing an at-a-glance overview of an OpenShift
cluster: node readiness and resource usage, operator health, firing
alerts, pending CSRs with one-click approve, storage classes, OpenShift
Lightspeed model info, and Tailscale subnet-router checks.

%prep
%setup -q -n %{name}-%{version}

%build
# No build step - the plugin is plain HTML/CSS/JS.

%install
mkdir -p %{buildroot}%{_datadir}/cockpit/%{name}
cp manifest.json index.html app.js style.css \
   %{buildroot}%{_datadir}/cockpit/%{name}/

%files
%{_datadir}/cockpit/%{name}/

%changelog
* Fri Sep 25 2026 Sam Jage <sam@samjage.com> - 0.1.3-1
- Fix runRoot() missing superuser escalation — Tailscale masquerade-rule
  check was silently always reporting "Unknown (no root)"

* Wed Sep 25 2026 Sam Jage <sam@samjage.com> - 0.1.0-1.2
- Initial release
