"use strict";

/* ---- global error traps ---- */
window.addEventListener("error", function (e) {
    var msg = "[JS error] " + (e.message || String(e)) + " — " +
        (e.filename || "?") + ":" + (e.lineno || "?");
    console.error(msg);
    var sm = document.getElementById("status-msg");
    if (sm) { sm.style.color = "#c62828"; sm.textContent = msg; }
});
window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    var msg = "[Promise rejection] " + (r && r.message ? r.message : String(r));
    console.error(msg, r);
    var sm = document.getElementById("status-msg");
    if (sm) { sm.style.color = "#c62828"; sm.textContent = msg; }
});

/* ---- environment-specific settings ---- */
const LIGHTSPEED_NAMESPACE = "openshift-lightspeed";
const PROMETHEUS_NAMESPACE = "openshift-monitoring";
const PROMETHEUS_LABEL = "app.kubernetes.io/name=prometheus";
const AUTO_REFRESH_MS = 15000;

let OC_ENV = [];
let refreshTimer = null;
let homeDir = null;

/* ---- panel visibility state ----
   userHidden: persisted in ~/.config/cockpit-openshift-overview/config.json
   autoHidden: computed each refresh, hides panels whose backend is absent */
let userHidden = new Set();
let autoHidden = new Set();

/* ---- cluster health accumulator ---- */
let healthState = {
    nodesReady: null,
    nodesTotal: null,
    degradedOps: null,
    pendingCsrs: null,
    firingAlerts: null
};

/* ---- panel visibility ---- */

function configPath() {
    return homeDir + "/.config/cockpit-openshift-overview/config.json";
}

function loadConfig() {
    return cockpit.user().then(function (user) {
        homeDir = user.home;
        return cockpit.file(configPath()).read();
    }).then(function (raw) {
        if (raw) {
            try {
                var cfg = JSON.parse(raw);
                if (Array.isArray(cfg.hidden)) userHidden = new Set(cfg.hidden);
            } catch (e) {
                console.warn("[config] parse failed:", e);
            }
        }
        applyPanelVisibility();
        syncMenuCheckboxes();
    }).catch(function () {
        // No config file yet — fresh install.
        applyPanelVisibility();
        syncMenuCheckboxes();
    });
}

function saveConfig() {
    if (!homeDir) return;
    var cfg = { hidden: Array.from(userHidden) };
    cockpit.file(configPath()).replace(JSON.stringify(cfg, null, 2) + "\n")
        .catch(function (err) { console.warn("[config] save failed:", err); });
}

function applyPanelVisibility() {
    document.querySelectorAll(".panel[data-panel]").forEach(function (el) {
        var name = el.getAttribute("data-panel");
        if (userHidden.has(name) || autoHidden.has(name)) {
            el.classList.add("hidden");
        } else {
            el.classList.remove("hidden");
        }
    });
}

function syncMenuCheckboxes() {
    document.querySelectorAll("#panel-menu input[data-panel]").forEach(function (cb) {
        var name = cb.getAttribute("data-panel");
        cb.checked = !userHidden.has(name);
    });
}

function setupPanelMenu() {
    var btn = document.getElementById("panel-menu-btn");
    var menu = document.getElementById("panel-menu");
    if (!btn || !menu) return;

    menu.querySelectorAll("input[data-panel]").forEach(function (cb) {
        cb.addEventListener("change", function () {
            var name = cb.getAttribute("data-panel");
            if (cb.checked) userHidden.delete(name);
            else userHidden.add(name);
            applyPanelVisibility();
            saveConfig();
        });
    });

    btn.addEventListener("click", function (e) {
        e.stopPropagation();
        menu.classList.toggle("hidden");
    });

    document.addEventListener("click", function (e) {
        if (!menu.classList.contains("hidden") &&
            !menu.contains(e.target) && e.target !== btn) {
            menu.classList.add("hidden");
        }
    });

    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") menu.classList.add("hidden");
    });
}

/* ---- kubeconfig discovery ---- */

function findKubeconfig() {
    return cockpit.user().then(function (user) {
        var home = user.home;
        var candidates = [
            home + "/.config/cockpit-openshift-overview/kubeconfig",
            home + "/.kube/config",
            home + "/install-dir/auth/kubeconfig",
            home + "/.config/kube/config",
            "/etc/kubernetes/admin.conf"
        ];
        var overridePath = candidates[0];
        return cockpit.file(overridePath).read().then(function (overrideContent) {
            if (overrideContent && overrideContent.trim()) {
                var kc = overrideContent.trim();
                console.log("[kubeconfig] using override: " + kc);
                return ["KUBECONFIG=" + kc];
            }
            return tryCandidates(candidates.slice(1));
        });
    }).catch(function (err) {
        console.warn("[kubeconfig] discovery failed:", err);
        return [];
    });
}

function tryCandidates(paths) {
    if (paths.length === 0) {
        console.log("[kubeconfig] no config found in any candidate path");
        console.log("[kubeconfig] to fix, run: mkdir -p ~/.config/cockpit-openshift-overview && " +
                    "echo /path/to/your/kubeconfig > ~/.config/cockpit-openshift-overview/kubeconfig");
        return [];
    }
    var path = paths[0];
    return cockpit.file(path).read().then(function (content) {
        if (content !== null && content !== undefined) {
            console.log("[kubeconfig] using: " + path);
            return ["KUBECONFIG=" + path];
        }
        return tryCandidates(paths.slice(1));
    }).catch(function () {
        return tryCandidates(paths.slice(1));
    });
}

/* ---- low-level helpers ---- */

function runOc(args, jsonOutput) {
    const fullArgs = ["oc"].concat(args).concat(jsonOutput ? ["-o", "json"] : []);
    return cockpit.spawn(fullArgs, { err: "message", environ: OC_ENV }).then(function (output) {
        return jsonOutput ? JSON.parse(output) : output.trim();
    });
}

function runCmd(args) {
    return cockpit.spawn(args, { err: "message", environ: OC_ENV }).then(function (o) { return o.trim(); });
}

function runRoot(args) {
    return cockpit.spawn(args, { err: "message", environ: OC_ENV }).then(function (o) { return o.trim(); });
}

function confirmAction(msg) {
    return window.confirm(msg);
}

function ageFromTimestamp(ts) {
    const created = new Date(ts).getTime();
    const days = Math.floor((Date.now() - created) / 86400000);
    if (days > 0) return days + "d";
    const hours = Math.floor((Date.now() - created) / 3600000);
    return Math.max(hours, 0) + "h";
}

function pctColor(p) {
    if (p >= 85) return "bad";
    if (p >= 60) return "warn";
    return "ok";
}

function setCard(id, value, status) {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelector(".value").textContent = value;
    el.className = "card" + (status ? " " + status : "");
}

function sectionError(tbodySelector, colspan, message) {
    const tbody = document.querySelector(tbodySelector);
    if (tbody) tbody.innerHTML = '<tr><td colspan="' + colspan + '" class="section-error">' + message + "</td></tr>";
}

function sectionEmpty(tbodySelector, colspan, message) {
    const tbody = document.querySelector(tbodySelector);
    if (tbody) tbody.innerHTML = '<tr><td colspan="' + colspan + '" class="section-empty">' + message + "</td></tr>";
}

function applyBarWidths(root) {
    root.querySelectorAll(".bar-fill[data-pct]").forEach(function (bar) {
        var p = parseInt(bar.getAttribute("data-pct"), 10) || 0;
        bar.style.width = Math.min(p, 100) + "%";
    });
}

function markPanelAvailable(name) {
    if (autoHidden.has(name)) {
        autoHidden.delete(name);
        applyPanelVisibility();
    }
}

function markPanelUnavailable(name) {
    if (!autoHidden.has(name)) {
        autoHidden.add(name);
        applyPanelVisibility();
    }
}

/* ---- cluster version + nodes + update progress ---- */

function loadClusterAndNodes() {
    return Promise.all([
        runOc(["get", "clusterversion", "version"], true),
        runOc(["get", "nodes"], true),
        runCmd(["oc", "adm", "top", "nodes", "--no-headers"]).catch(function () { return null; })
    ]).then(function (results) {
        const cv = results[0], nodeList = results[1], topRaw = results[2];

        document.getElementById("cluster-name").textContent =
            "Cluster ID: " + (cv.spec.clusterID || "unknown");

        const version = cv.status.desired ? cv.status.desired.version : "unknown";
        setCard("card-version", version, "");

        const nodes = nodeList.items;
        const readyCount = nodes.filter(function (n) {
            const cond = (n.status.conditions || []).find(function (c) { return c.type === "Ready"; });
            return cond && cond.status === "True";
        }).length;
        setCard("card-nodes", readyCount + " / " + nodes.length,
            readyCount === nodes.length ? "ok" : "bad");

        healthState.nodesReady = readyCount;
        healthState.nodesTotal = nodes.length;

        renderUpdateBanner(cv);
        renderNodes(nodes, buildUsageMap(topRaw));
        renderNodeStorage(nodes);
    }).catch(function (err) {
        setCard("card-version", "?", "bad");
        setCard("card-nodes", "?", "bad");
        sectionError("#nodes-table tbody", 7, "Failed to load nodes: " + (err.message || err));
        sectionError("#node-storage-table tbody", 2, "Unavailable");
    });
}

function buildUsageMap(topRaw) {
    var usageMap = {};
    if (!topRaw) return usageMap;
    topRaw.split("\n").forEach(function (line) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
            usageMap[parts[0]] = {
                cpuPct: parseInt(parts[2], 10) || 0,
                memPct: parseInt(parts[4], 10) || 0
            };
        }
    });
    return usageMap;
}

function renderUpdateBanner(cv) {
    const banner = document.getElementById("banner");
    const progressing = (cv.status.conditions || []).find(function (c) { return c.type === "Progressing"; });
    if (!progressing || progressing.status !== "True") {
        banner.style.display = "none";
        return;
    }
    banner.style.display = "block";
    document.getElementById("banner-text").textContent = progressing.message || "Update in progress";
    const match = /\((\d+)% complete\)/.exec(progressing.message || "");
    document.getElementById("banner-bar").style.width = (match ? match[1] : 0) + "%";
}

function renderNodes(nodes, usageMap) {
    const tbody = document.querySelector("#nodes-table tbody");
    tbody.innerHTML = "";
    if (nodes.length === 0) {
        sectionEmpty("#nodes-table tbody", 7, "No nodes found");
        return;
    }

    nodes.forEach(function (node) {
        const name = node.metadata.name;
        const conditions = node.status.conditions || [];
        const readyCond = conditions.find(function (c) { return c.type === "Ready"; });
        const isReady = readyCond && readyCond.status === "True";
        const isSchedDisabled = !!node.spec.unschedulable;

        let badgeClass = "ready", badgeText = "Ready";
        if (!isReady) { badgeClass = "notready"; badgeText = "NotReady"; }
        else if (isSchedDisabled) { badgeClass = "schedulingdisabled"; badgeText = "SchedulingDisabled"; }

        const roles = Object.keys(node.metadata.labels || {})
            .filter(function (l) { return l.indexOf("node-role.kubernetes.io/") === 0; })
            .map(function (l) { return l.replace("node-role.kubernetes.io/", ""); })
            .join(", ") || "-";

        const usage = usageMap[name];
        let usageCell = '<span class="usage-none">no metrics</span>';
        if (usage) {
            usageCell =
                '<div class="usage-row"><span class="usage-label">CPU</span>' +
                '<div class="bar-track"><div class="bar-fill ' + pctColor(usage.cpuPct) + '" data-pct="' + usage.cpuPct + '"></div></div>' +
                '<span class="usage-pct">' + usage.cpuPct + "%</span></div>" +
                '<div class="usage-row"><span class="usage-label">Mem</span>' +
                '<div class="bar-track"><div class="bar-fill ' + pctColor(usage.memPct) + '" data-pct="' + usage.memPct + '"></div></div>' +
                '<span class="usage-pct">' + usage.memPct + "%</span></div>";
        }

        const actionLabel = isSchedDisabled ? "Uncordon" : "Cordon";
        const actionClass = isSchedDisabled ? "" : "danger";

        const tr = document.createElement("tr");
        tr.innerHTML =
            "<td>" + name + "</td>" +
            "<td>" + roles + "</td>" +
            '<td><span class="badge ' + badgeClass + '">' + badgeText + "</span></td>" +
            "<td>" + (node.status.nodeInfo.kubeletVersion || "-") + "</td>" +
            "<td>" + ageFromTimestamp(node.metadata.creationTimestamp) + "</td>" +
            '<td class="usage-cell">' + usageCell + "</td>" +
            '<td><button class="small ' + actionClass + '" data-node="' + name + '" data-action="' +
            (isSchedDisabled ? "uncordon" : "cordon") + '">' + actionLabel + "</button></td>";
        tbody.appendChild(tr);
    });

    applyBarWidths(tbody);

    tbody.querySelectorAll("button[data-action]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            const node = btn.getAttribute("data-node");
            const action = btn.getAttribute("data-action");
            if (!confirmAction(action[0].toUpperCase() + action.slice(1) + " node " + node + "?")) return;
            btn.disabled = true;
            runOc(["adm", action, node], false).then(function () {
                loadClusterAndNodes();
            }).catch(function (err) {
                alert("Failed: " + (err.message || err));
                btn.disabled = false;
            });
        });
    });
}

function renderNodeStorage(nodes) {
    const tbody = document.querySelector("#node-storage-table tbody");
    const rows = [];
    nodes.forEach(function (node) {
        const annotations = node.metadata.annotations || {};
        const capKey = Object.keys(annotations).find(function (k) { return k.indexOf("capacity.topolvm.io/") === 0; });
        if (capKey) {
            const bytes = parseInt(annotations[capKey], 10);
            if (!isNaN(bytes)) {
                const gb = (bytes / 1e9).toFixed(0);
                rows.push("<tr><td>" + node.metadata.name + "</td><td>" + gb + " GB</td></tr>");
            }
        }
    });
    tbody.innerHTML = rows.length ? rows.join("") :
        '<tr><td colspan="2" class="section-empty">No topolvm capacity annotations found</td></tr>';
}

/* ---- operators ---- */

function loadOperators() {
    return runOc(["get", "co"], true).then(function (list) {
        const operators = list.items;
        const degradedCount = operators.filter(function (op) {
            const deg = (op.status.conditions || []).find(function (c) { return c.type === "Degraded"; });
            return deg && deg.status === "True";
        }).length;
        setCard("card-operators", degradedCount, degradedCount === 0 ? "ok" : "bad");
        healthState.degradedOps = degradedCount;
        renderOperators(operators);
    }).catch(function (err) {
        setCard("card-operators", "?", "bad");
        sectionError("#operators-table tbody", 5, "Failed to load operators: " + (err.message || err));
    });
}

function renderOperators(operators) {
    const tbody = document.querySelector("#operators-table tbody");
    const needsAttention = operators.filter(function (op) {
        const conds = op.status.conditions || [];
        const get = function (t) {
            const c = conds.find(function (c) { return c.type === t; });
            return c ? c.status : "Unknown";
        };
        return get("Available") !== "True" || get("Progressing") === "True" || get("Degraded") === "True";
    });

    if (needsAttention.length === 0) {
        sectionEmpty("#operators-table tbody", 5, "All operators healthy");
        return;
    }

    tbody.innerHTML = needsAttention.map(function (op) {
        const conds = op.status.conditions || [];
        const get = function (t) {
            const c = conds.find(function (c) { return c.type === t; });
            return c ? { status: c.status, message: c.message || "" } : { status: "?", message: "" };
        };
        const avail = get("Available"), prog = get("Progressing"), deg = get("Degraded");
        const message = deg.message || prog.message || avail.message || "";
        return "<tr><td>" + op.metadata.name + "</td><td>" + avail.status + "</td><td>" + prog.status +
            "</td><td>" + deg.status + "</td><td>" + message.substring(0, 120) + "</td></tr>";
    }).join("");
}

/* ---- firing alerts ---- */

function loadAlerts() {
    return runOc(["get", "pods", "-n", PROMETHEUS_NAMESPACE, "-l", PROMETHEUS_LABEL,
        "-o", "jsonpath={.items[0].metadata.name}"], false)
        .then(function (podName) {
            if (!podName) throw new Error("No Prometheus pod found with label " + PROMETHEUS_LABEL);
            return runOc(["exec", "-n", PROMETHEUS_NAMESPACE, "-c", "prometheus", podName, "--",
                "curl", "-s", "--max-time", "5",
                "http://localhost:9090/api/v1/alerts?state=firing"], false);
        })
        .then(function (raw) {
            const parsed = JSON.parse(raw);
            const arr = (parsed.data && parsed.data.alerts) || (Array.isArray(parsed.data) ? parsed.data : []);
            const alerts = arr.filter(function (a) {
                return a.labels && a.labels.alertname !== "Watchdog";
            });
            setCard("card-alerts", alerts.length, alerts.length === 0 ? "ok" : "warn");
            healthState.firingAlerts = alerts.length;
            renderAlerts(alerts);
        }).catch(function (err) {
            setCard("card-alerts", "?", "");
            sectionError("#alerts-table tbody", 4, "Prometheus unavailable: " + (err.message || err));
        });
}

function renderAlerts(alerts) {
    if (alerts.length === 0) {
        sectionEmpty("#alerts-table tbody", 4, "No alerts firing");
        return;
    }
    const tbody = document.querySelector("#alerts-table tbody");
    tbody.innerHTML = alerts.map(function (a) {
        const severity = a.labels.severity || "info";
        const summary = (a.annotations && (a.annotations.summary || a.annotations.description)) || "-";
        return "<tr><td>" + a.labels.alertname + '</td><td><span class="badge ' + severity + '">' + severity +
            "</span></td><td>" + (a.labels.namespace || "-") + "</td><td>" + summary.substring(0, 140) + "</td></tr>";
    }).join("");
}

/* ---- certificate signing requests ---- */

function loadCsrs() {
    return runOc(["get", "csr"], true).then(function (list) {
        const items = list.items;
        const pending = items.filter(function (c) { return !c.status || Object.keys(c.status).length === 0; });
        setCard("card-csr", pending.length, pending.length === 0 ? "ok" : "warn");
        healthState.pendingCsrs = pending.length;
        renderCsrs(items, pending);
    }).catch(function (err) {
        setCard("card-csr", "?", "");
        sectionError("#csr-table tbody", 5, "Failed to load CSRs: " + (err.message || err));
        document.getElementById("approve-all-btn").style.display = "none";
    });
}

function renderCsrs(items, pending) {
    const tbody = document.querySelector("#csr-table tbody");
    const approveAllBtn = document.getElementById("approve-all-btn");

    if (pending.length === 0) {
        approveAllBtn.style.display = "none";
    } else {
        approveAllBtn.style.display = "inline-block";
        approveAllBtn.onclick = function () {
            if (!confirmAction("Approve all " + pending.length + " pending CSRs?")) return;
            approveAllBtn.disabled = true;
            const names = pending.map(function (c) { return c.metadata.name; });
            runOc(["adm", "certificate", "approve"].concat(names), false).then(function () {
                loadCsrs();
            }).catch(function (err) {
                alert("Failed: " + (err.message || err));
                approveAllBtn.disabled = false;
            });
        };
    }

    if (items.length === 0) {
        sectionEmpty("#csr-table tbody", 5, "No certificate requests");
        return;
    }

    const sorted = items.slice().sort(function (a, b) {
        const aPending = !a.status || Object.keys(a.status).length === 0;
        const bPending = !b.status || Object.keys(b.status).length === 0;
        return (bPending ? 1 : 0) - (aPending ? 1 : 0);
    }).slice(0, 25);

    tbody.innerHTML = "";
    sorted.forEach(function (csr) {
        const isPending = !csr.status || Object.keys(csr.status).length === 0;
        const requestor = csr.spec.username || "-";
        const tr = document.createElement("tr");
        tr.innerHTML =
            "<td>" + csr.metadata.name + "</td>" +
            "<td>" + requestor + "</td>" +
            "<td>" + ageFromTimestamp(csr.metadata.creationTimestamp) + "</td>" +
            '<td><span class="badge ' + (isPending ? "pending" : "ok") + '">' + (isPending ? "Pending" : "Approved") + "</span></td>" +
            "<td>" + (isPending ? '<button class="small" data-csr="' + csr.metadata.name + '">Approve</button>' : "-") + "</td>";
        tbody.appendChild(tr);
    });

    tbody.querySelectorAll("button[data-csr]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            const name = btn.getAttribute("data-csr");
            btn.disabled = true;
            runOc(["adm", "certificate", "approve", name], false).then(function () {
                loadCsrs();
            }).catch(function (err) {
                alert("Failed: " + (err.message || err));
                btn.disabled = false;
            });
        });
    });
}

/* ---- storage classes ---- */

function loadStorage() {
    return Promise.all([
        runOc(["get", "sc"], true),
        runOc(["get", "pvc", "-A"], true)
    ]).then(function (results) {
        const scList = results[0], pvcList = results[1];

        const bound = pvcList.items.filter(function (p) { return p.status.phase === "Bound"; }).length;
        setCard("card-pvc", bound + " / " + pvcList.items.length,
            bound === pvcList.items.length ? "ok" : "warn");

        const tbody = document.querySelector("#storageclass-table tbody");
        if (scList.items.length === 0) {
            sectionEmpty("#storageclass-table tbody", 3, "No storage classes");
            return;
        }
        tbody.innerHTML = scList.items.map(function (sc) {
            const isDefault = (sc.metadata.annotations || {})["storageclass.kubernetes.io/is-default-class"] === "true";
            return "<tr><td>" + sc.metadata.name + "</td><td>" + sc.provisioner + "</td><td>" +
                (isDefault ? '<span class="badge ok">Default</span>' : "-") + "</td></tr>";
        }).join("");
    }).catch(function (err) {
        setCard("card-pvc", "?", "");
        sectionError("#storageclass-table tbody", 3, "Failed to load storage: " + (err.message || err));
    });
}

/* ---- OpenShift Lightspeed ---- */

function loadLightspeed() {
    const box = document.getElementById("lightspeed-box");

    return Promise.all([
        runOc(["get", "olsconfigs.ols.openshift.io", "cluster"], true)
            .catch(function () { return null; }),
        runOc(["get", "pods", "-n", LIGHTSPEED_NAMESPACE], true)
            .catch(function () { return null; }),
        runCmd(["oc", "adm", "top", "pod", "-n", LIGHTSPEED_NAMESPACE, "--no-headers"])
            .catch(function () { return null; })
    ]).then(function (results) {
        const cfg = results[0], podList = results[1], topRaw = results[2];

        // If neither the CR nor any pods are present, treat Lightspeed as
        // absent on this cluster and auto-hide the section.
        if (!cfg && (!podList || !podList.items || podList.items.length === 0)) {
            markPanelUnavailable("lightspeed");
            return;
        }
        markPanelAvailable("lightspeed");

        const pods = (podList && podList.items) || [];
        const running = pods.filter(function (p) { return p.status.phase === "Running"; });
        const appPod = running.find(function (p) {
            return (p.metadata.name || "").indexOf("lightspeed-app-server") === 0;
        }) || running[0];

        let statusBadge;
        if (appPod) {
            statusBadge = '<span class="badge ok">Running</span>';
        } else if (pods.length > 0) {
            statusBadge = '<span class="badge warn">' + (pods[0].status.phase || "Unknown") + "</span>";
        } else {
            statusBadge = '<span class="badge bad">Not running</span>';
        }

        let model = "-", providerName = "-", providerType = "-";
        if (cfg && cfg.spec) {
            const ols = cfg.spec.ols || {};
            model = ols.defaultModel || "-";
            providerName = ols.defaultProvider || "-";
            const providers = (cfg.spec.llm && cfg.spec.llm.providers) || [];
            const match = providers.find(function (p) { return p.name === providerName; });
            if (match && match.type) providerType = match.type;
        }

        let usageRow = "";
        if (topRaw && appPod) {
            const line = topRaw.split("\n").find(function (l) {
                return l.trim().indexOf(appPod.metadata.name) === 0;
            });
            if (line) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 3) {
                    usageRow = '<div class="info-row"><span class="k">Pod usage</span><span class="v">' +
                        parts[1] + " CPU / " + parts[2] + "</span></div>";
                }
            }
        }

        box.innerHTML =
            '<div class="info-title">OpenShift Lightspeed ' + statusBadge + "</div>" +
            '<div class="info-row"><span class="k">Model</span><span class="v">' + model + "</span></div>" +
            '<div class="info-row"><span class="k">Provider</span><span class="v">' +
                providerName + (providerType !== "-" ? ' <span class="badge info">' + providerType + "</span>" : "") +
            "</span></div>" +
            (appPod ? '<div class="info-row"><span class="k">Pod</span><span class="v">' + appPod.metadata.name + "</span></div>" : "") +
            usageRow;
    }).catch(function (err) {
        box.innerHTML = '<div class="info-title">OpenShift Lightspeed <span class="badge bad">Error</span></div>' +
            '<div class="section-error">' + (err.message || err) + "</div>";
    });
}

/* ---- Tailscale ---- */

function loadTailscale() {
    const box = document.getElementById("tailscale-box");

    return Promise.all([
        runCmd(["tailscale", "status", "--json"]).catch(function () { return null; }),
        runRoot(["iptables", "-t", "nat", "-L", "POSTROUTING", "-n"]).catch(function () { return null; }),
        runCmd(["ip", "rule", "list"]).catch(function () { return null; })
    ]).then(function (results) {
        const statusRaw = results[0], natRaw = results[1], ipRuleRaw = results[2];

        // If the tailscale binary isn't present or the daemon is unreachable,
        // auto-hide the section.
        if (!statusRaw) {
            markPanelUnavailable("tailscale");
            return;
        }
        markPanelAvailable("tailscale");

        const status = JSON.parse(statusRaw);
        const self = status.Self || {};
        const routes = self.PrimaryRoutes || [];
        const masqOk = !!(natRaw && natRaw.indexOf("100.64.0.0/10") !== -1);
        const ipRuleOk = !!(ipRuleRaw && ipRuleRaw.indexOf("100.64.0.0/10") !== -1);

        box.innerHTML =
            '<div class="info-title">Tailscale <span class="badge ' + (self.Online !== false ? "ok" : "bad") + '">' +
            (self.Online !== false ? "Connected" : "Offline") + "</span></div>" +
            '<div class="info-row"><span class="k">Hostname</span><span class="v">' + (self.HostName || "-") + '</span></div>' +
            '<div class="info-row"><span class="k">Advertised subnet routes</span><span class="v">' +
                (routes.length > 0 ? routes.join(", ") : "None") + "</span></div>" +
            '<div class="info-row"><span class="k">Masquerade rule present</span><span class="v badge ' +
            (masqOk ? "ok" : (natRaw === null ? "warn" : "bad")) + '">' +
            (natRaw === null ? "Unknown (no root)" : (masqOk ? "Yes" : "No")) + "</span></div>" +
            '<div class="info-row"><span class="k">Return route present</span><span class="v badge ' +
            (ipRuleOk ? "ok" : "bad") + '">' + (ipRuleOk ? "Yes" : "No") + "</span></div>";
    }).catch(function (err) {
        box.innerHTML = '<div class="info-title">Tailscale <span class="badge bad">Error</span></div>' +
            '<div class="section-error">' + (err.message || err) + "</div>";
    });
}

/* ---- console link ---- */

function loadConsoleLink() {
    return runCmd(["oc", "whoami", "--show-console"]).then(function (url) {
        const link = document.getElementById("console-link");
        link.href = url;
        link.style.display = "inline-block";
    }).catch(function () {
        document.getElementById("console-link").style.display = "none";
    });
}

/* ---- cluster health hero ---- */

function renderHealth() {
    const hero = document.getElementById("health-hero");
    const title = document.getElementById("health-title");
    const sub = document.getElementById("health-sub");
    if (!hero) return;

    if (healthState.nodesReady === null && healthState.degradedOps === null) {
        hero.className = "health-hero";
        title.textContent = "Cluster health unknown";
        sub.textContent = "Couldn't read cluster state — check the sections below.";
        return;
    }

    const issues = [];

    if (healthState.degradedOps !== null && healthState.degradedOps > 0) {
        issues.push(healthState.degradedOps + " degraded operator" +
            (healthState.degradedOps === 1 ? "" : "s"));
    }
    if (healthState.nodesReady !== null && healthState.nodesTotal !== null &&
        healthState.nodesReady < healthState.nodesTotal) {
        const notReady = healthState.nodesTotal - healthState.nodesReady;
        issues.push(notReady + " node" + (notReady === 1 ? "" : "s") + " not ready");
    }

    if (issues.length === 0) {
        hero.className = "health-hero ok";
        title.textContent = "Cluster healthy";
        sub.textContent =
            healthState.nodesReady + " / " + healthState.nodesTotal + " nodes ready · " +
            "no degraded operators";
    } else {
        hero.className = "health-hero bad";
        title.textContent = "Cluster needs attention";
        sub.textContent = issues.join(" · ");
    }
}

/* ---- orchestration ---- */

function refresh() {
    document.getElementById("error-box").style.display = "none";
    document.getElementById("status-msg").textContent = "Refreshing...";

    healthState = {
        nodesReady: null,
        nodesTotal: null,
        degradedOps: null,
        pendingCsrs: null,
        firingAlerts: null
    };

    Promise.allSettled([
        loadClusterAndNodes(),
        loadOperators(),
        loadAlerts(),
        loadCsrs(),
        loadStorage(),
        loadLightspeed(),
        loadTailscale(),
        loadConsoleLink()
    ]).then(function () {
        renderHealth();
        document.getElementById("status-msg").textContent =
            "Last updated " + new Date().toLocaleTimeString();
    }).catch(function (err) {
        var sm = document.getElementById("status-msg");
        if (sm) { sm.style.color = "#c62828"; sm.textContent = "refresh() failed: " + (err.message || err); }
    });
}

document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("refresh-btn");
    if (btn) btn.addEventListener("click", refresh);

    setupPanelMenu();

    findKubeconfig().then(function (env) {
        OC_ENV = env;
        return loadConfig();
    }).then(function () {
        refresh();
        refreshTimer = window.setInterval(refresh, AUTO_REFRESH_MS);
    });
});

document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
        if (refreshTimer) { window.clearInterval(refreshTimer); refreshTimer = null; }
    } else if (!refreshTimer) {
        refresh();
        refreshTimer = window.setInterval(refresh, AUTO_REFRESH_MS);
    }
});

window.addEventListener("beforeunload", function () {
    if (refreshTimer) window.clearInterval(refreshTimer);
});
