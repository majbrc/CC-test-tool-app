(function () {
  "use strict";

  var state = null;
  var currentSuite = null;
  var currentTarget = null;
  var currentFile = null;
  var pollTimer = null;
  var modelFields = {};
  var modelFieldSequence = 0;
  var targetSuiteSelection = {};
  var previewEnvironment = 0;
  var environmentSaving = false;
  var environmentTypeAhead = "";
  var environmentTypeTime = 0;
  var activeModel = null;
  var activeDefinitionPath = null;
  var activeCommon = null;
  var modelRequest = 0;
  var activeReview = null;
  var builderKind = "guided";
  var timestampRequest = 0;
  var fileRequest = 0;
  var yearRequest = 0;
  var sourceDestinations = {};
  var sourceSequence = 0;
  var sourceRequest = 0;
  var technicalPanelSequence = 0;

  var elements = {
    environmentSelect: document.getElementById("environment-select"),
    environmentPicker: document.getElementById("environment-picker"),
    environmentOptions: document.getElementById("environment-options"),
    environmentPopup: document.getElementById("environment-popup"),
    environmentSelectedName: document.getElementById("environment-selected-name"),
    environmentDetail: document.getElementById("environment-detail"),
    homeScreen: document.getElementById("home-screen"),
    testsConfigurationScreen: document.getElementById("tests-configuration-screen"),
    openTestsConfiguration: document.getElementById("open-tests-configuration"),
    backToHome: document.getElementById("back-to-home"),
    shellEnvironment: document.getElementById("shell-environment"),
    suiteList: document.getElementById("suite-list"),
    suiteSearch: document.getElementById("suite-search"),
    suiteConfigList: document.getElementById("suite-config-list"),
    suiteConfigSearch: document.getElementById("suite-config-search"),
    openReport: document.getElementById("open-report"),
    reportHint: document.getElementById("report-hint"),
    message: document.getElementById("message"),
    suiteDialog: document.getElementById("suite-dialog"),
    suiteDialogTitle: document.getElementById("suite-dialog-title"),
    suiteDialogEnvironment: document.getElementById("suite-dialog-environment"),
    suiteModel: document.getElementById("suite-model"),
    suiteFileGroups: document.getElementById("suite-file-groups"),
    yearSettings: document.getElementById("year-settings"),
    testBuilderDialog: document.getElementById("test-builder-dialog"),
    testBuilderForm: document.getElementById("test-builder-form"),
    testBuilderTitle: document.getElementById("test-builder-title"),
    testBuilderIntro: document.getElementById("test-builder-intro"),
    testBuilderDestination: document.getElementById("test-builder-destination"),
    testBuilderSource: document.getElementById("test-builder-source"),
    testBuilderMethod: document.getElementById("test-builder-method"),
    testBuilderTemplate: document.getElementById("test-builder-template"),
    testBuilderName: document.getElementById("test-builder-name"),
    testBuilderPosition: document.getElementById("test-builder-position"),
    testBuilderLabels: document.getElementById("test-builder-labels"),
    testBuilderDetails: document.getElementById("test-builder-details"),
    testBuilderState: document.getElementById("test-builder-state"),
    testBuilderPreview: document.getElementById("test-builder-preview"),
    reviewDialog: document.getElementById("review-dialog"),
    reviewTitle: document.getElementById("review-title"),
    reviewContent: document.getElementById("review-content"),
    reviewConfirmWrap: document.getElementById("review-confirm-wrap"),
    reviewConfirm: document.getElementById("review-confirm"),
    reviewError: document.getElementById("review-error"),
    reviewStatus: document.getElementById("review-status"),
    reviewCommit: document.getElementById("review-commit"),
    createTarget: document.getElementById("create-target"),
    targetDialog: document.getElementById("target-dialog"),
    targetForm: document.getElementById("target-form"),
    targetName: document.getElementById("target-name"),
    targetDescription: document.getElementById("target-description"),
    targetEnvironment: document.getElementById("target-environment"),
    targetSuiteSearch: document.getElementById("target-suite-search"),
    targetSuiteFiles: document.getElementById("target-suite-files"),
    targetSuiteCount: document.getElementById("target-suite-count"),
    saveTarget: document.getElementById("save-target"),
    editorDialog: document.getElementById("editor-dialog"),
    editorCategory: document.getElementById("editor-category"),
    editorTitle: document.getElementById("editor-title"),
    editorPath: document.getElementById("editor-path"),
    fileEditor: document.getElementById("file-editor"),
    editorState: document.getElementById("editor-state"),
    saveFile: document.getElementById("save-file"),
    runBanner: document.getElementById("run-banner"),
    runTitle: document.getElementById("run-title"),
    runSubtitle: document.getElementById("run-subtitle"),
    showRunLog: document.getElementById("show-run-log"),
    logDialog: document.getElementById("log-dialog"),
    runLog: document.getElementById("run-log")
  };

  function api(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (options.body) {
      options.headers["Content-Type"] = "application/json";
    }
    return fetch(path, options).then(function (response) {
      return response.text().then(function (text) {
        var data;
        try { data = text ? JSON.parse(text) : {}; }
        catch (error) { throw new Error("Unexpected server response (HTTP " + response.status + ")."); }
        if (!response.ok) {
          var failure = new Error(data.error || ("Request failed with status " + response.status));
          failure.status = response.status;
          throw failure;
        }
        return data;
      });
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function label(value) {
    var exactLabels = {
      testFilterLabel: "Test Filter Label",
      xmlTemplateFile: "XML Template File Location"
    };
    if (exactLabels[value]) { return exactLabels[value]; }
    return String(value || "")
      .replace(/^cc\./, "")
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function showMessage(text, isError) {
    elements.message.textContent = text;
    elements.message.classList.toggle("is-error", Boolean(isError));
    elements.message.hidden = false;
    window.clearTimeout(showMessage.timer);
    showMessage.timer = window.setTimeout(function () { elements.message.hidden = true; }, 5000);
  }

  function previewOperation(payload, title, onSaved, context) {
    var review = { payload: payload, onSaved: onSaved, title: title, context: context };
    activeReview = review;
    elements.reviewDialog.showModal();
    elements.reviewTitle.textContent = title;
    elements.reviewContent.innerHTML = "<div class=\"model-loading\"><span class=\"spinner\"></span>&nbsp;Checking affected files...</div>";
    elements.reviewError.hidden = true;
    elements.reviewConfirm.checked = false;
    elements.reviewCommit.disabled = true;
    elements.reviewStatus.textContent = "Previewing; no changes saved";
    api("/api/config/preview", { method: "POST", body: JSON.stringify(payload) }).then(function (preview) {
      if (activeReview !== review || !elements.reviewDialog.open) { return; }
      review.preview = preview;
      var changes = preview.changes || [];
      var impact = preview.impact || [];
      var warnings = preview.warnings || [];
      var data = preview.data || {};
      var matchingPaths = data.files || (review.context && review.context.files || []).map(function (file) {
        return file.path;
      });
      elements.reviewContent.innerHTML =
        "<p class=\"review-summary\">" + changes.length + " file" + (changes.length === 1 ? "" : "s") +
        " will be created or updated. Nothing has been saved yet.</p>" +
        (changes.length ? "<h3>Files</h3><ul class=\"review-list\">" + changes.map(function (item) {
          return "<li><span class=\"badge\">" + escapeHtml(item.action) + "</span><code>" +
            escapeHtml(item.path) + "</code></li>";
        }).join("") + "</ul>" : "<p>No files need changing.</p>") +
        (review.context && review.context.files ? "<h3>Matching input XMLs (" +
          matchingPaths.length + ")</h3><p>" + (review.context.replaceValue
            ? "Values will be replaced with " + (payload.value === "" ? "an empty value" :
              "<code>" + escapeHtml(payload.value) + "</code>") +
              " in matching constants, declaration defaults, and scenario values. "
            : "Each XML keeps its current value. ") + "The effective editor type will be " +
          escapeHtml(payload.editorType) + " in every listed file.</p><ul class=\"review-list\">" +
          matchingPaths.map(function (path) {
            var entries = review.context.files.filter(function (candidate) {
              return String(candidate.path).replace(/\\/g, "/") === String(path).replace(/\\/g, "/");
            });
            var oldTypes = entries.map(function (entry) { return entry.editorType; }).filter(Boolean);
            var oldValues = review.context.replaceValue ? entries.map(function (entry) { return entry.value; }).filter(function (value) {
              return value != null;
            }) : [];
            return "<li><code>" + escapeHtml(path) + "</code> · " +
              escapeHtml(oldTypes.join(" / ") || "see XML declaration") + " → " +
              escapeHtml(payload.editorType) +
              (oldValues.length ? " · current value(s): <code>" +
                escapeHtml(oldValues.join(" / ")) + "</code>" : "") + "</li>";
          }).join("") + "</ul>" : "") +
        ((data.values || []).length ? "<details class=\"review-values\"" +
          (review.context && review.context.replaceValue ? " open" : "") +
          "><summary>XML values: " + data.values.filter(function (item) {
            return item.before !== item.after;
          }).length + " changed, " + data.values.filter(function (item) {
            return item.before === item.after;
          }).length + " preserved (" + data.values.length + " entries)</summary>" +
          "<ul class=\"review-list\">" + data.values.map(function (item) {
            return "<li><span class=\"badge\">" + (item.before === item.after ? "keep" : "replace") +
              "</span><code>" + escapeHtml(item.path) + "</code> · <code>" +
              escapeHtml(item.nodePath) + "</code> · " + escapeHtml(item.attribute) +
              ": <code>" + (item.before === "" ? "(empty)" : escapeHtml(item.before)) +
              "</code> → <code>" + (item.after === "" ? "(empty)" : escapeHtml(item.after)) +
              "</code></li>";
          }).join("") + "</ul></details>" : "") +
        (impact.length ? "<h3>Affected tests and settings</h3><ul class=\"review-list\">" +
          impact.map(function (item) { return "<li>" + escapeHtml(item) + "</li>"; }).join("") + "</ul>" : "") +
        (warnings.length ? "<div class=\"review-warning\"><strong>Check before applying</strong><ul>" +
          warnings.map(function (item) { return "<li>" + escapeHtml(item) + "</li>"; }).join("") + "</ul></div>" : "") +
        (data.runnerLabel ? "<p>Runner selection: <code>" + escapeHtml(data.runnerLabel) +
          "</code> · " + escapeHtml(data.scenarioCount) + " matching scenarios</p>" : "") +
        (data.sourceInputPath ? "<p>Independent input: <code>" + escapeHtml(data.newInputPath) +
          "</code></p>" : "") +
        ((data.newValidationPaths || []).length ? "<p>Independent validations: " +
          escapeHtml(data.newValidationPaths.join(", ")) + "</p>" : "") +
        ((data.newSessionPaths || []).length ? "<p>Independent session definitions: " +
          escapeHtml(data.newSessionPaths.join(", ")) + "</p>" : "") +
        ((data.sharedDependencies || []).length ? "<p>Still shared: " +
          escapeHtml(data.sharedDependencies.join(", ")) + "</p>" : "");
      elements.reviewConfirmWrap.hidden = !impact.length && !warnings.length;
      elements.reviewCommit.disabled = Boolean(impact.length || warnings.length);
      elements.reviewStatus.textContent = "Ready to apply";
    }).catch(function (error) {
      if (activeReview !== review || !elements.reviewDialog.open) { return; }
      elements.reviewContent.innerHTML = "";
      elements.reviewError.textContent = "Preview failed: " + error.message;
      elements.reviewError.hidden = false;
      elements.reviewStatus.textContent = "Preview failed; no changes saved";
    });
  }

  function commitReview() {
    var review = activeReview;
    if (!review || !review.preview) { return; }
    elements.reviewCommit.disabled = true;
    elements.reviewError.hidden = true;
    elements.reviewStatus.textContent = "Applying checked changes...";
    var request = Object.assign({}, review.payload, { revisions: review.preview.revisions });
    api("/api/config/commit", { method: "POST", body: JSON.stringify(request) }).then(function () {
      if (activeReview !== review) { return; }
      elements.reviewDialog.close();
      activeReview = null;
      showMessage("Changes saved.");
      if (review.onSaved) { return review.onSaved(); }
    }).catch(function (error) {
      if (activeReview !== review) { return; }
      elements.reviewError.textContent = (error.status === 409
        ? "Files changed since preview. Close this review and preview again. " : "") + error.message;
      elements.reviewError.hidden = false;
      elements.reviewStatus.textContent = "Save failed; no changes confirmed";
      elements.reviewCommit.disabled = error.status === 409;
      if (error.status === 409) { review.preview = null; }
    });
  }

  function renderScreen() {
    var configurationOpen = window.location.hash === "#tests-configuration";
    var reportOpen = window.location.hash === "#report";
    closeEnvironmentPicker(false);
    elements.homeScreen.hidden = configurationOpen || reportOpen;
    elements.testsConfigurationScreen.hidden = !configurationOpen;
    document.getElementById("report-screen").hidden = !reportOpen;
    if (reportOpen) { reportView.show(); } else { reportView.hide(); }
    document.title = configurationOpen
      ? "Tests Configuration · Automated Testing Tool"
      : reportOpen ? "Test report · Automated Testing Tool" : "Automated Testing Tool";
    window.scrollTo(0, 0);
  }

  function openTestsConfiguration() {
    if (window.location.hash === "#tests-configuration") {
      renderScreen();
    } else {
      window.location.hash = "tests-configuration";
    }
  }

  function backToHome() {
    if (window.location.hash) {
      window.location.hash = "";
    } else {
      renderScreen();
    }
  }

  function renderEnvironments() {
    elements.environmentSelectedName.textContent = state.selectedEnvironment || "No environments";
    elements.environmentSelect.disabled = environmentSaving || !state.environments.length;
    elements.shellEnvironment.textContent = state.selectedEnvironment + " environment";
    elements.environmentOptions.setAttribute("aria-busy", String(environmentSaving));
    document.getElementById("environment-preview-previous").disabled = environmentSaving;
    document.getElementById("environment-preview-next").disabled = environmentSaving;
    elements.environmentOptions.innerHTML = state.environments.map(function (environment, index) {
      return '<div id="environment-option-' + index + '" role="option" aria-selected="' +
        (environment.name === state.selectedEnvironment) + '" data-environment-index="' + index +
        '"><span>' + escapeHtml(environment.name) + '</span>' +
        (environment.name === state.selectedEnvironment ? '<span class="badge">Active</span>' : "") + "</div>";
    }).join("");
    if (previewEnvironment >= state.environments.length) { previewEnvironment = 0; }
    previewEnvironmentDetails(previewEnvironment);
  }

  function previewEnvironmentDetails(index) {
    if (!state || !state.environments[index]) { return; }
    previewEnvironment = index;
    var selected = state.environments[index];
    elements.environmentOptions.setAttribute("aria-activedescendant", "environment-option-" + index);
    elements.environmentOptions.querySelectorAll("[data-environment-index]").forEach(function (option) {
      option.classList.toggle("is-previewed", Number(option.getAttribute("data-environment-index")) === index);
    });
    var allProperties = Object.keys(selected.properties).sort().map(function (key) {
      return "<dt>" + escapeHtml(label(key)) + "</dt><dd>" + escapeHtml(selected.properties[key]) + "</dd>";
    }).join("");
    elements.environmentDetail.innerHTML =
      '<p class="eyebrow">Environment details</p><h3>' + escapeHtml(selected.name) + "</h3>" +
      (selected.name === state.selectedEnvironment ? "<span class=\"badge\">Active</span>" : "") +
      '<dl class="environment-picker__properties">' + allProperties + "</dl>";
  }

  function openEnvironmentPicker() {
    if (!state || !state.environments.length || environmentSaving) { return; }
    if (elements.environmentPopup.hidden) {
      previewEnvironment = Math.max(0, state.environments.findIndex(function (environment) {
        return environment.name === state.selectedEnvironment;
      }));
    }
    elements.environmentPopup.hidden = false;
    elements.environmentSelect.setAttribute("aria-expanded", "true");
    previewEnvironmentDetails(previewEnvironment);
    elements.environmentOptions.focus();
  }

  function closeEnvironmentPicker(restoreFocus) {
    if (!elements.environmentPopup) { return; }
    var wasOpen = !elements.environmentPopup.hidden;
    elements.environmentPopup.hidden = true;
    elements.environmentSelect.setAttribute("aria-expanded", "false");
    environmentTypeAhead = "";
    if (restoreFocus && wasOpen) { elements.environmentSelect.focus(); }
  }

  function environmentPickerKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault(); closeEnvironmentPicker(true); return;
    }
    if (event.target !== elements.environmentOptions || environmentSaving || !state.environments.length) { return; }
    var index = previewEnvironment, length = state.environments.length;
    if (event.key === "ArrowDown") { index = (index + 1) % length; }
    else if (event.key === "ArrowUp") { index = (index + length - 1) % length; }
    else if (event.key === "Home") { index = 0; }
    else if (event.key === "End") { index = length - 1; }
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); selectEnvironment(state.environments[index].name); return;
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      var now = Date.now();
      environmentTypeAhead = (now - environmentTypeTime < 700 ? environmentTypeAhead : "") + event.key.toLowerCase();
      environmentTypeTime = now;
      var found = state.environments.findIndex(function (environment) {
        return environment.name.toLowerCase().indexOf(environmentTypeAhead) === 0;
      });
      if (found >= 0) { index = found; }
    } else { return; }
    event.preventDefault();
    previewEnvironmentDetails(index);
    document.getElementById("environment-option-" + index).scrollIntoView({ block: "nearest" });
  }

  function displaySuitePath(path) {
    return String(path || "").replace(/^TEST\//, "");
  }

  function fileCount(suite) {
    return Object.keys(suite.files).reduce(function (count, category) {
      return count + suite.files[category].length;
    }, 0);
  }

  function suiteFolderFromPath(path) {
    var parts = String(path || "").replace(/\\/g, "/").split("/");
    return parts.length > 2 && parts[0] === "TEST" ? parts[1] : "";
  }

  function renderTargets() {
    var query = elements.suiteSearch.value.trim().toLowerCase();
    var targets = (state.targets || []).filter(function (target) {
      return target.name.toLowerCase().indexOf(query) !== -1 ||
        String(target.description || "").toLowerCase().indexOf(query) !== -1 ||
        (target.suites || []).join(" ").toLowerCase().indexOf(query) !== -1;
    });
    elements.suiteList.innerHTML = targets.length ? targets.map(function (target) {
      var suiteLinks = (target.suites || []).map(function (path) {
        return "<li><button class=\"target-suite-link\" data-suite-path=\"" + escapeHtml(path) +
          "\" type=\"button\" title=\"Configure " + escapeHtml(path) + "\">" +
          escapeHtml(displaySuitePath(path)) + "</button></li>";
      }).join("");
      var environmentOptions = "<option value=\"Default\"" +
        (target.environment === "Default" ? " selected" : "") + ">Default</option>" +
        state.environments.map(function (environment) {
        return "<option value=\"" + escapeHtml(environment.name) + "\"" +
          (environment.name === target.environment ? " selected" : "") + ">" +
          escapeHtml(environment.name) + "</option>";
      }).join("");
      return "<article class=\"suite-row target-card\" data-target=\"" + escapeHtml(target.name) + "\">" +
        "<div class=\"target-card__identity\"><h3>" + escapeHtml(target.description || target.name) + "</h3>" +
        "<p class=\"target-card__technical-name\">Ant target: <code>" + escapeHtml(target.name) + "</code></p></div>" +
        "<div class=\"suite-row__actions target-card__actions\">" +
        "<label class=\"target-environment-field\"><span>Environment</span>" +
        "<select class=\"target-environment\" data-target-environment aria-label=\"Environment for " +
        escapeHtml(target.name) + "\">" + environmentOptions + "</select></label>" +
        "<button class=\"button button--emphasized\" data-action=\"run-target\" type=\"button\">Run</button>" +
        "<div class=\"target-card__suite-group\"><span class=\"target-card__suite-label\">Included test suites (" +
        (target.suites || []).length + ")</span><ul class=\"target-card__suites\">" + suiteLinks +
        "</ul></div></div></article>";
    }).join("") : "<div class=\"empty\">No Ant test targets match your search.</div>";
  }

  function renderSuiteConfiguration() {
    var query = elements.suiteConfigSearch.value.trim().toLowerCase();
    var suites = state.suites.filter(function (suite) {
      return suite.displayName.toLowerCase().indexOf(query) !== -1 ||
        suite.name.toLowerCase().indexOf(query) !== -1;
    });
    elements.suiteConfigList.innerHTML = suites.length ? suites.map(function (suite) {
      var definitions = suite.files.suites ? suite.files.suites.length : 0;
      return "<article class=\"suite-row\" data-suite=\"" + escapeHtml(suite.name) + "\">" +
        "<div><h3><button class=\"suite-link\" data-action=\"configure-suite\" type=\"button\">" +
        escapeHtml(suite.displayName) + "</button></h3><p>" + definitions + " suite definition" +
        (definitions === 1 ? "" : "s") + " · " + fileCount(suite) +
        " configuration files</p></div><div class=\"suite-row__actions\">" +
        "<button class=\"button\" data-action=\"configure-suite\" type=\"button\">Configure</button>" +
        "</div></article>";
    }).join("") : "<div class=\"empty\">No test suites match your search.</div>";
  }

  function loadYear() {
    var sequence = ++yearRequest;
    elements.yearSettings.textContent = "Loading year configuration...";
    return api("/api/config/year").then(function (year) {
      if (sequence !== yearRequest) { return; }
      var current = new Intl.DateTimeFormat("en", { timeZone: "Europe/Vilnius", year: "numeric" }).format(new Date());
      var mixed = year.mixed || year.mode === "mixed";
      elements.yearSettings.innerHTML = "<div class=\"year-controls\">" +
        "<label class=\"model-field\"><span>Mode</span><select id=\"year-mode\">" +
        "<option value=\"automatic\"" + (year.mode === "automatic" ? " selected" : "") +
        ">Automatic · current year (" + current + ")</option>" +
        "<option value=\"fixed\"" + (year.mode === "fixed" ? " selected" : "") +
        ">Fixed year</option></select></label>" +
        "<label class=\"model-field\"><span>Fixed year</span><input id=\"year-value\" type=\"text\" inputmode=\"numeric\" pattern=\"[0-9]{4}\" maxlength=\"4\" value=\"" +
        escapeHtml(year.mode === "fixed" ? year.value : current) + "\"></label>" +
        "<button id=\"year-preview\" class=\"button button--emphasized\" type=\"button\">Review year change</button></div>" +
        (mixed ? "<p class=\"inline-warning\">Existing CURRENT_YEAR declarations have different or custom values. Review all affected files before resolving this mixed configuration.</p>" : "") +
        "<p class=\"field-help\">" + (year.files || []).length +
        " input file(s) use CURRENT_YEAR. Automatic mode preserves the framework's live year expression; Fixed mode writes the same year to every managed declaration.</p>";
      var modeControl = document.getElementById("year-mode");
      var valueControl = document.getElementById("year-value");
      function syncMode() { valueControl.disabled = modeControl.value !== "fixed"; }
      modeControl.addEventListener("change", syncMode);
      syncMode();
      document.getElementById("year-preview").addEventListener("click", function () {
        var mode = modeControl.value;
        if (mode === "fixed" && !valueControl.checkValidity()) {
          valueControl.reportValidity();
          return;
        }
        previewOperation({ operation: "year", mode: mode, value: mode === "fixed" ? valueControl.value : undefined },
          "Review CURRENT_YEAR change", function () { loadYear(); if (elements.suiteDialog.open) { refreshSuiteModel(); } });
      });
    }).catch(function (error) {
      if (sequence !== yearRequest) { return; }
      elements.yearSettings.innerHTML = "<p class=\"inline-error\">Unable to load CURRENT_YEAR: " +
        escapeHtml(error.message) + "</p>";
    });
  }

  function renderReport() {
    elements.openReport.disabled = !state.reportAvailable;
    elements.reportHint.textContent = state.reportAvailable ? "View the latest generated results" : "No report has been generated yet";
  }

  function loadState() {
    return api("/api/state").then(function (data) {
      state = data;
      renderEnvironments();
      renderTargets();
      renderSuiteConfiguration();
      renderReport();
      loadYear();
      return updateRunStatus();
    }).catch(function (error) {
      showMessage("Unable to load the application: " + error.message, true);
    });
  }

  function selectEnvironment(environment) {
    if (environmentSaving || !state || !state.environments.some(function (item) { return item.name === environment; })) { return; }
    if (environment === state.selectedEnvironment) { closeEnvironmentPicker(true); return; }
    environmentSaving = true;
    renderEnvironments();
    return api("/api/environment", {
      method: "POST",
      body: JSON.stringify({ environment: environment })
    }).then(function () {
      state.selectedEnvironment = environment;
      elements.targetEnvironment.value = environment;
      closeEnvironmentPicker(false);
      showMessage("Active environment changed to " + environment + ".");
    }).catch(function (error) {
      showMessage(error.message, true);
    }).then(function () {
      environmentSaving = false;
      renderEnvironments();
      if (elements.environmentPopup.hidden && !elements.homeScreen.hidden) { elements.environmentSelect.focus(); }
    });
  }

  function suiteByName(name) {
    return state.suites.filter(function (suite) { return suite.name === name; })[0];
  }

  function expressionBacked(raw, display) {
    return Boolean(display && display.parameterized) ||
      /\$\{|\$!|\$[A-Za-z_][\w.]*|#(?:if|elseif|else|end|set|foreach|macro|parse|include)\b/.test(String(raw == null ? "" : raw));
  }

  function safeDisplay(raw, display) {
    if (/^\s*\$(?:_TEST_DIR|\{_TEST_DIR\})/.test(String(raw == null ? "" : raw))) {
      return { parameterized: true, status: "raw", value: raw,
        reason: "_TEST_DIR paths are displayed exactly as stored, without substitution.", sources: [] };
    }
    if (display && display.parameterized) { return display; }
    if (expressionBacked(raw)) {
      return { parameterized: true, status: "unresolved",
        reason: "This server did not provide a verified display for this expression. The XML remains unchanged.",
        sources: [] };
    }
    return { parameterized: false, status: "literal", value: raw == null ? "" : String(raw) };
  }

  function displayValue(raw, metadata) {
    var display = safeDisplay(raw, metadata);
    if (display.status === "resolved" || display.status === "preview" || display.status === "raw") {
      return display.value == null ? "Unable to resolve" : String(display.value);
    }
    if (display.status === "runtime") { return "Determined at runtime"; }
    if (display.status === "unresolved") { return "Unable to resolve"; }
    return raw == null ? "" : String(raw);
  }

  function displayDetails(raw, metadata) {
    var display = safeDisplay(raw, metadata);
    if (!display.parameterized) { return ""; }
    return "<span class=\"badge badge--parameterized\">Parameterized</span>" +
      (display.status === "preview" ? "<span class=\"badge badge--preview\">Preview</span>" : "") +
      "<details class=\"parameter-details\"><summary>Expression and sources</summary>" +
      "<p>XML expression: <code>" + escapeHtml(raw) + "</code></p>" +
      (display.status === "preview" ? "<p>Preview only; execution may use a different instant." +
        (display.evaluatedAt ? " Evaluated at " + escapeHtml(display.evaluatedAt) : "") +
        (display.zone ? " (" + escapeHtml(display.zone) + ")" : "") + "</p>" : "") +
      (display.reason ? "<p>" + escapeHtml(display.reason) + "</p>" : "") +
      ((display.sources || []).length ? "<ul class=\"parameter-sources\">" + display.sources.map(function (source) {
        var id = "source-" + (++sourceSequence);
        sourceDestinations[id] = source;
        var editable = source.editable && !expressionBacked(source.value) &&
          source.sourcePath && source.nodePath && source.attribute && source.revision;
        return "<li><strong>" + escapeHtml(source.name || "Source") + "</strong>" +
          (source.sourcePath ? " <code>" + escapeHtml(source.sourcePath) + "</code>" : "") +
          "<span>Source value: <code>" + escapeHtml(source.value) + "</code></span>" +
          (source.globalYear ? "<button class=\"button\" type=\"button\" data-year-source>" +
            "Edit shared CURRENT_YEAR configuration</button>" : editable ?
            "<button class=\"button\" type=\"button\" data-edit-source=\"" + id + "\">Edit source</button>" :
            "<span class=\"field-help\">No verified editable literal destination; use the raw XML editor if needed.</span>") +
          "</li>";
      }).join("") + "</ul>" : "<p>No verified editable literal source is available.</p>") + "</details>";
  }

  function expressionEditButton(key) {
    var entry = key && modelFields[key];
    var field = entry && entry.field;
    return field && field.sourcePath && field.nodePath && field.attribute && field.revision
      ? "<button class=\"button\" type=\"button\" data-edit-expression=\"" + key + "\">Edit source value</button>" : "";
  }

  function resolvedControl(raw, display, id) {
    return "<div class=\"parameter-value\"><output" + (id ? " id=\"" + escapeHtml(id) + "\"" : "") +
      ">" + escapeHtml(displayValue(raw, display)) +
      "</output>" + displayDetails(raw, display) + expressionEditButton(id) + "</div>";
  }
  function fieldControl(field, key, test) {
    var value = field.value == null ? "" : String(field.value);
    var type = String(field.editorType || field.type || "string").toLowerCase();
    modelFields[key] = { field: field, test: test };
    if (expressionBacked(value, field.display)) {
      return resolvedControl(value, field.display, key);
    }
    if (field.label === "testFilterLabel") {
      return filterLabelControl(field, key, test);
    }
    if (type === "unixtimestamp") {
      return "<div class=\"timestamp-editor\" data-timestamp=\"" + key + "\">" +
        "<div class=\"timestamp-raw\"><input id=\"" + key + "\" data-model-field=\"" + key +
        "\" type=\"text\" value=\"" + escapeHtml(value) + "\" aria-label=\"" +
        escapeHtml(label(field.label)) + " raw value\"><small>Raw milliseconds or expression; expressions stay unchanged.</small></div>" +
        "<button class=\"button timestamp-switch\" data-timestamp-switch=\"" + key +
        "\" type=\"button\">Use fixed date and time</button>" +
        "<div class=\"timestamp-fixed\" hidden><label>Europe/Vilnius date and time (seconds and milliseconds)" +
        "<input data-timestamp-local=\"" + key + "\" type=\"datetime-local\" step=\"0.001\"></label>" +
        "<label>Offset / occurrence<select data-timestamp-offset=\"" + key +
        "\"><option value=\"\">Check local time</option><option value=\"+02:00\">UTC+02:00 · winter / later overlap</option>" +
        "<option value=\"+03:00\">UTC+03:00 · summer / earlier overlap</option></select></label>" +
        "<p class=\"timestamp-preview\" data-timestamp-preview=\"" + key + "\" role=\"status\">Enter a local time to preview its Unix milliseconds.</p>" +
        "<button class=\"button\" data-timestamp-save=\"" + key +
        "\" type=\"button\" disabled>Save fixed milliseconds</button></div></div>";
    }
    if (type === "boolean") {
      return "<input id=\"" + key + "\" data-model-field=\"" + key + "\" type=\"checkbox\"" +
        (value.toLowerCase() === "true" ? " checked" : "") + ">";
    }
    var numeric = type === "number" && value.trim() !== "" &&
      /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value.trim());
    return "<input id=\"" + key + "\" data-model-field=\"" + key + "\" type=\"" +
      (numeric ? "number\" step=\"any" : "text") + "\" value=\"" + escapeHtml(value) + "\">";
  }

  function filterLabelValues(value) {
    var seen = Object.create(null);
    return String(value || "").split(",").map(function (item) {
      return item;
    }).filter(function (item) {
      if (!item || seen[item]) { return false; }
      seen[item] = true;
      return true;
    });
  }

  function selectedFilterLabels(test, field) {
    var labels = test && test.selectedLabels ? test.selectedLabels : filterLabelValues(field && field.value);
    return labels.map(function (item) { return String(item).split(":")[0]; }).filter(Boolean);
  }

  function filterLabelControl(field, key, test) {
    var values = selectedFilterLabels(test, field);
    var chips = values.length ? values.map(function (value, index) {
      return "<span class=\"filter-label-chip\"><span>" + escapeHtml(value) + "</span>" +
        "<button data-remove-filter-label=\"" + key + "\" data-filter-label-index=\"" + index +
        "\" type=\"button\" aria-label=\"Remove filter label " + escapeHtml(value) + "\">×</button></span>";
    }).join("") : "<span class=\"filter-label-empty\">No filter labels configured</span>";
    return "<div class=\"filter-label-editor\" data-filter-label-editor=\"" + key + "\">" +
      "<div class=\"filter-label-values\">" + chips + "</div><div class=\"filter-label-entry\">" +
      "<input data-filter-label-input=\"" + key + "\" type=\"text\" list=\"available-" + key +
      "\" aria-label=\"New test filter label\" " +
      "placeholder=\"Enter one or more comma-separated labels\">" +
      "<button class=\"button\" data-add-filter-label=\"" + key + "\" type=\"button\">Add label</button>" +
      "</div><datalist id=\"available-" + key + "\">" +
      (test && test.availableLabels || []).map(function (item) {
        return "<option value=\"" + escapeHtml(item) + "\"></option>";
      }).join("") + "</datalist><small>Selections are mapped to runnable input scenarios; they are not saved as a comma-separated runner value." +
      (field.value && field.value.indexOf(":") !== -1 ? " Scenario ID restriction " +
        escapeHtml(field.value.substring(field.value.indexOf(":"))) + " is preserved." : "") +
      " Whitespace is significant in existing input labels.</small></div>";
  }

  function renderFields(fields, test, options) {
    if (!fields || !fields.length) {
      return "<div class=\"empty\">No editable properties</div>";
    }
    options = options || {};
    return "<div class=\"model-fields\">" + fields.map(function (field) {
      var key = "field-" + (++modelFieldSequence);
      var name = field.name || field.label;
      var configurable = field.sourcePath && name && field.label !== "testFilterLabel" &&
        (field.attribute === "paramValue" || field.attribute === "constValue") &&
        !(options.commonNames && options.commonNames.indexOf(name) !== -1);
      var displayType = field.editorType || field.type || "string";
      var typeSelect = configurable ? "<div class=\"type-settings\"><label for=\"type-" + key +
        "\">Editor type <span class=\"type-origin\">" + (field.declaredType
          ? "Declared: " + escapeHtml(field.declaredType) : "Inferred / GUI-only") +
        "</span></label><select id=\"type-" + key + "\" data-type-field=\"" + key + "\">" +
        ["string", "number", "date", "unixTimestamp"].map(function (item) {
          return "<option value=\"" + item + "\"" +
            (String(displayType).toLowerCase() === item.toLowerCase() ? " selected" : "") + ">" +
            (item === "unixTimestamp" ? "Unix timestamp (ms)" : label(item)) + "</option>";
        }).join("") + "</select></div>" : "";
      var help = options.commonNames && options.commonNames.indexOf(name) !== -1
        ? "<small class=\"field-help\">Type is set for this suite under Common user properties above; " +
          (expressionBacked(field.value, field.display) ? "edit its verified source instead of replacing this expression.</small>" : "this scenario value remains editable.</small>")
        : field.declaredType && options.shared
          ? "<small class=\"field-help\">Shared input declaration; changing its type affects all referencing tests.</small>"
          : "";
      if (field.label === "testFilterLabel") {
        return "<div class=\"model-field model-field--wide\" data-model-container=\"" + key + "\"><span>" +
          escapeHtml(label(field.label)) + "</span>" + fieldControl(field, key, test) + "</div>";
      }
      return "<div class=\"model-field" + (displayType === "unixTimestamp" ? " model-field--wide" : "") +
        "\" data-model-container=\"" + key + "\"><label for=\"" + key + "\">" +
        escapeHtml(label(field.label || field.attribute)) + "</label>" + typeSelect + fieldControl(field, key, test) +
        help + "</div>";
    }).join("") + "</div>";
  }

  function referenceChips(references) {
    references = references || {};
    var items = [];
    if (references.templatePath) { items.push("Template: " + references.templatePath); }
    (references.validationPaths || []).forEach(function (path) { items.push("Validation: " + path); });
    (references.sessionPaths || []).forEach(function (path) { items.push("Session: " + path); });
    return items.length ? "<div class=\"reference-list\">" + items.map(function (item) {
      return "<span class=\"reference-chip\" title=\"" + escapeHtml(item) + "\">" + escapeHtml(item) + "</span>";
    }).join("") + "</div>" : "";
  }

  function renderValidations(validations, test) {
    if (!validations || !validations.length) { return ""; }
    return "<section class=\"object-panel object-panel--validation\"><div class=\"object-panel__header\"><div>" +
      "<h4>Result validations</h4><p>Expected results evaluated after this test case runs</p></div></div>" +
      "<div class=\"validation-stack\">" + validations.map(function (validation) {
        return "<details class=\"validation-card\"><summary>" + escapeHtml(validation.name || validation.path) +
          "</summary><div class=\"validation-card__body\">" + (validation.groups || []).map(function (group) {
            return "<section class=\"validation-group\"><h6>" + escapeHtml(group.title || "Validation") +
              "</h6>" + renderFields(group.fields, test) + "</section>";
          }).join("") + "</div></details>";
      }).join("") + "</div></section>";
  }

  function renderScenarios(test, commonNames) {
    var scenarios = test.scenarios || [];
    var title = test.userDefinition ? "User definition" : "Test cases";
    var description = test.userDefinition ?
      "Subscriber, account, contract, and user parameters used by this suite test" :
      "Input properties and execution parameters selected by the suite label";
    return "<section class=\"object-panel" + (test.userDefinition ? " object-panel--user" : "") + "\">" +
      "<div class=\"object-panel__header\"><div><h4>" + title + "</h4><p>" + description + "</p></div>" +
      "<span class=\"badge\">" + scenarios.length + " object" + (scenarios.length === 1 ? "" : "s") + "</span></div>" +
      (scenarios.length ? "<div class=\"scenario-stack\">" + scenarios.map(function (scenario) {
        var fields = (scenario.fields || []).filter(function (field) {
          return field.label !== "labels" && !(field.attribute === "constValue" &&
            commonNames.indexOf(field.name || field.label) !== -1);
        });
        var technicalNames = ["cipropertiesfile", "sapccapi", "generatecit",
          "onerrorfailthetest", "testextension", "errormessage"];
        var technical = fields.filter(function (field) {
          return technicalNames.indexOf(String(field.name || field.label || "").toLowerCase()) !== -1;
        });
        var ordinary = fields.filter(function (field) { return technical.indexOf(field) === -1; });
        var panelId = technical.length ? "technical-panel-" + (++technicalPanelSequence) : "";
        return "<article class=\"scenario-card\"><h5>" +
          (test.userDefinition ? "User object " : "Test case ") + escapeHtml(scenario.id || "") +
          (scenario.labels ? " · " + (expressionBacked(scenario.labels) ? "Parameterized labels" :
            escapeHtml(scenario.labels)) : "") + "</h5>" +
          (ordinary.length || !technical.length ?
            renderFields(ordinary, test, { shared: true, commonNames: commonNames }) : "") +
          (technical.length ? "<div class=\"technical-details\">" +
            "<button class=\"button technical-details__toggle\" type=\"button\" data-technical-toggle=\"" +
            panelId + "\" aria-controls=\"" + panelId + "\" aria-expanded=\"false\">Technical Details</button>" +
            "<div class=\"technical-details__panel\" id=\"" + panelId + "\" hidden>" +
            renderFields(technical, test, { shared: true, commonNames: commonNames }) + "</div></div>" : "") +
          referenceChips(scenario.references) +
          renderValidations(scenario.validations, test) + "</article>";
      }).join("") + "</div>" : "<div class=\"empty\">No input object matches label " +
        escapeHtml(test.label || "") + ".</div>") + "</section>";
  }

  function renderTestObject(test, index, common) {
    var commonNames = (common && common.properties || []).map(function (item) { return item.name; });
    return "<details class=\"test-object\"" + (index === 0 ? " open" : "") + "><summary>" +
      "<span class=\"test-object__title\">" + escapeHtml(test.name) + "</span><span class=\"test-object__meta\">" +
      (test.userDefinition ? "<span class=\"badge\">User</span>" : "<span class=\"badge\">Test</span>") +
      (test.label ? expressionBacked(test.label) ? "<span class=\"badge badge--parameterized\">Parameterized filter</span>" :
        "<span class=\"reference-chip\">" +
        escapeHtml(selectedFilterLabels(test, { value: test.label }).join(", ")) + "</span>" : "") +
      "</span></summary><div class=\"object-body\"><div class=\"test-actions\">" +
      "<button class=\"button\" type=\"button\" data-duplicate-test=\"" + escapeHtml(test.nodePath || "") +
      "\">Duplicate independently</button></div>" +
      "<section class=\"object-panel\"><div class=\"object-panel__header\"><div><h4>Suite test settings</h4>" +
      "<p>" + escapeHtml(test.inputPath || "No input XML") +
      (test.methods && test.methods.length ? " · " + escapeHtml(test.methods.join(", ")) : "") +
      "</p></div></div>" + renderFields(test.fields, test) + "</section>" +
      renderScenarios(test, commonNames) + "</div></details>";
  }

  function renderCommon(common, definitionPath) {
    if (!common) { return "<div class=\"empty\">Loading shared user properties...</div>"; }
    if (common.error) {
      return "<p class=\"inline-error\">Shared properties unavailable: " + escapeHtml(common.error) + "</p>";
    }
    var properties = common.properties || [];
    if (!properties.length) { return "<p class=\"field-help\">No shared user properties were discovered in this suite.</p>"; }
    return "<div class=\"common-grid\">" + properties.map(function (property, index) {
      var inputId = "common-" + definitionPath.replace(/[^A-Za-z0-9_-]/g, "-") + "-" + index;
      var entries = property.values || [];
      var files = property.files || [];
      var protectedValue = expressionBacked(entries.length ? entries[0].value : "", property.display) ||
        entries.some(function (item) { return expressionBacked(item.value, item.display); }) ||
        files.some(function (item) { return expressionBacked(item.value, item.display); });
      var displayEntries = files.length && files.some(function (item) { return item.display; }) ? files : entries;
      var displayVariants = displayEntries.map(function (item) {
        var display = safeDisplay(item.value, item.display);
        return display.status + "|" + displayValue(item.value, item.display);
      });
      var variesByFile = displayVariants.some(function (item) { return item !== displayVariants[0]; });
      var value = property.mixed ? "" : (entries.length && entries[0].value != null ? String(entries[0].value) : "");
      var filePaths = files.map(function (file) { return file.path; }).filter(function (path, position, paths) {
        return paths.indexOf(path) === position;
      });
      var type = property.mixedType ? "" : (property.editorType || "");
      var supportedTypes = ["string", "number", "date", "unixTimestamp"];
      var selectedType = supportedTypes.filter(function (option) {
        return option.toLowerCase() === String(type).toLowerCase();
      })[0] || "";
      var hasTimestamp = /MILLIS/i.test(property.name) ||
        files.some(function (file) { return String(file.editorType).toLowerCase() === "unixtimestamp"; });
      var typeSummary = property.mixedType ? "Mixed editor types across input XMLs" :
        (type ? "Current editor type: " + (type === "unixTimestamp" ? "Unix timestamp (ms)" : label(type))
          : "No editor type reported");
      if (type && !selectedType) { typeSummary += " (choose a supported editor type)"; }
      var typeOptions = supportedTypes.map(function (option) {
        return "<option value=\"" + option + "\"" +
          (option === selectedType ? " selected" : "") + ">" +
          (option === "unixTimestamp" ? "Unix timestamp (ms)" : label(option)) + "</option>";
      }).join("");
      var typeControl = "<div class=\"common-type-setting\"><label for=\"" + escapeHtml(inputId) +
        "-type\">Editor type for all matching input XMLs</label><select id=\"" + escapeHtml(inputId) +
        "-type\" data-common-suite-type=\"" + index + "\">" +
        "<option value=\"\" disabled" + (!selectedType ? " selected" : "") + ">Choose a type for all</option>" +
        typeOptions + "</select><p class=\"field-help\">" + escapeHtml(typeSummary) +
        ". By default, changing type keeps each existing value, including mixed values and expressions.</p>" +
        "<label class=\"common-replace\"><input type=\"checkbox\" data-common-type-replace=\"" + index +
        "\"" + (protectedValue ? " disabled" : "") + "><span>Also replace every matching value with the common value above (including blank if left empty). This includes XML constants, declaration defaults, and scenario values.</span></label>" +
        (protectedValue ? "<p class=\"field-help\">Value replacement is unavailable because at least one XML value is parameterized. Type-only review keeps every expression intact.</p>" : "") +
        "<button class=\"button\" type=\"button\" data-common-type-preview=\"" + index +
        "\" data-common-path=\"" + escapeHtml(definitionPath) +
        "\"" + (!selectedType ? " disabled" : "") + ">Review type for all XMLs</button></div>";
      var typeDetails = "<details class=\"common-type-details\"><summary>Type by XML entry (" + files.length +
        ")</summary><ul class=\"common-type-list\">" + files.map(function (file) {
          var origin = file.typeSource === "metadata" ? "saved GUI setting" :
            file.typeSource === "declared" ? "XML declaration" : "inferred";
          return "<li><code>" + escapeHtml(file.path) + "</code><span>" +
            escapeHtml(file.kind === "parameter" ? "Parameter declaration" : "Constant") +
            " · XML declared: " + escapeHtml(file.declaredType || "none") +
            " · Effective editor: " + escapeHtml(file.editorType || "unknown") +
            " (" + origin + ")</span></li>";
        }).join("") + "</ul></details>";
      var timeControl = "<div class=\"common-timestamp\" " + (hasTimestamp && !protectedValue ? "" : "hidden ") +
        "data-common-timestamp-base=\"" + (hasTimestamp && !protectedValue) + "\" data-common-timestamp=\"" +
        escapeHtml(inputId) + "\"><button class=\"button\" type=\"button\" data-common-time-switch=\"" +
        escapeHtml(inputId) + "\">Switch to fixed Vilnius date and time</button><div hidden>" +
        "<label>Local time (seconds and milliseconds)<input data-common-time-local=\"" +
        escapeHtml(inputId) + "\" type=\"datetime-local\" step=\"0.001\"></label>" +
        "<label>Offset / occurrence<select data-common-time-offset=\"" + escapeHtml(inputId) +
        "\"><option value=\"\">Check local time</option><option value=\"+02:00\">UTC+02:00</option>" +
        "<option value=\"+03:00\">UTC+03:00</option></select></label>" +
        "<p data-common-time-preview=\"" + escapeHtml(inputId) + "\" role=\"status\">Choose a local time.</p>" +
        "<button class=\"button\" type=\"button\" data-common-time-use=\"" + escapeHtml(inputId) +
        "\" disabled>Use these milliseconds</button></div></div>";
      var valueControl = protectedValue ?
        (property.mixed || variesByFile ?
          "<div class=\"parameter-value\"><output>" + (property.mixed ? "Mixed values" : "Varies by XML") +
            "</output><span class=\"badge badge--parameterized\">Parameterized</span></div>" :
          resolvedControl(value, property.display ||
            (entries.length && entries[0].display) || (files.length && files[0].display))) +
        "<button class=\"button\" type=\"button\" data-expression-files=\"" + escapeHtml(inputId) +
        "-expressions\">Edit source value</button>" +
        "<details class=\"parameter-details\" id=\"" + escapeHtml(inputId) +
        "-expressions\"><summary>Values by XML entry (" +
        displayEntries.length + ")</summary><ul class=\"parameter-sources\">" +
        displayEntries.map(function (item) {
          var key = "field-" + (++modelFieldSequence);
          if (expressionBacked(item.value, item.display)) { modelFields[key] = { field: item }; }
          return "<li>" + escapeHtml(item.path || item.sourcePath || item.kind || property.name) +
            ": <strong>" + escapeHtml(displayValue(item.value, item.display)) + "</strong>" +
            displayDetails(item.value, item.display) + expressionEditButton(key) + "</li>";
        }).join("") + "</ul></details>" :
        "<label for=\"" + escapeHtml(inputId) + "\">Common value (optional for type changes)</label>" +
        "<input id=\"" + escapeHtml(inputId) + "\" type=\"text\" data-common-input=\"" +
        escapeHtml(definitionPath) + "\" data-common-index=\"" + index + "\" value=\"" + escapeHtml(value) +
        "\" placeholder=\"" + (property.mixed ? "Mixed values — enter one common value" : "") + "\">";
      return "<div class=\"common-property\"><strong>" + escapeHtml(label(property.name)) + "</strong>" +
        valueControl + "<p class=\"field-help\">" +
        (property.mixed ? "<strong>Mixed raw values; unchanged by type-only review.</strong> " : "") +
        filePaths.length + " input file(s) · " + (property.tests || []).length + " referencing test(s)" +
        (!property.mixed && !protectedValue ? " · Current: " + escapeHtml(value) : "") +
        "</p><p class=\"field-help\">" + (protectedValue ?
          "Edit a verified literal source above or use the advanced XML editor. Shared value replacement is disabled." :
          "Value-only review changes matching constants; to replace declaration defaults and scenario values too, select the checkbox under editor type.") +
        "</p>" + timeControl +
        "<button class=\"button\" type=\"button\" data-common-preview=\"" + index +
        "\" data-common-path=\"" + escapeHtml(definitionPath) + "\"" +
        (property.mixed || protectedValue ? " disabled" : "") + ">Review common constants value</button>" +
        typeControl + typeDetails + "</div>";
    }).join("") + "</div>";
  }
  function renderSuiteModel(model, definitionPath, common) {
    modelFields = {};
    modelFieldSequence = 0;
    technicalPanelSequence = 0;
    sourceDestinations = {};
    sourceSequence = 0;
    activeModel = model;
    activeCommon = common;
    var definitions = model.definitions || [];
    if (definitionPath) {
      definitions = definitions.filter(function (definition) {
        return String(definition.path).replace(/\\/g, "/") === String(definitionPath).replace(/\\/g, "/");
      });
    }
    elements.suiteModel.innerHTML = definitions.length ? definitions.map(function (definition) {
      return "<article class=\"definition-card\"><header class=\"definition-card__header\"><h3>" +
        escapeHtml(definition.name || "Suite definition") + "</h3><code>" + escapeHtml(definition.path) +
        "</code></header><section class=\"definition-card__settings\"><div class=\"object-panel__header\">" +
        "<div><h4>Suite definition</h4><p>Main object for the tests and configuration below</p></div></div>" +
        renderFields((definition.fields || []).filter(function (field) {
          return field.attribute !== "parallel" && field.attribute !== "preserve-order";
        })) + "</section><section class=\"common-panel\"><div class=\"object-panel__header\"><div>" +
        "<h4>Common user properties</h4><p>Set shared values once at the top; review every affected test before applying.</p>" +
        "</div></div>" +         renderCommon(common && common[definition.path], definition.path) + "</section>" +
        "<div class=\"definition-card__tests\"><div class=\"definition-card__test-header\"><h4>Tests in this definition</h4>" +
        "<button class=\"button button--emphasized\" type=\"button\" data-add-test=\"" +
        escapeHtml(definition.path) + "\">Add test</button></div>" +
        (definition.tests || []).map(function (test, index) {
          return renderTestObject(test, index, common && common[definition.path]);
        }).join("") + "</div></article>";
    }).join("") : "<div class=\"empty\">The selected suite definition could not be found.</div>";
  }

  function openSuite(name, definitionPath) {
    currentSuite = suiteByName(name);
    if (!currentSuite) { showMessage("Suite not found: " + name, true); return; }
    activeDefinitionPath = definitionPath || null;
    var definitionName = definitionPath ? definitionPath.split(/[\\/]/).pop() : "";
    elements.suiteDialogTitle.textContent = definitionName
      ? currentSuite.displayName + " · " + definitionName
      : currentSuite.displayName;
    elements.suiteDialogEnvironment.textContent = definitionPath
      ? "Selected suite definition: " + displaySuitePath(definitionPath)
      : "Configuration files under TEST/" + currentSuite.name;
    elements.suiteModel.innerHTML = "<div class=\"model-loading\"><span class=\"spinner\"></span>&nbsp; Mapping suite objects...</div>";
    var categoryLabels = {
      suites: "Suite definitions",
      inputs: "Test inputs",
      templates: "Templates",
      validations: "Validations"
    };
    elements.suiteFileGroups.innerHTML = Object.keys(categoryLabels).map(function (category) {
      var files = currentSuite.files[category] || [];
      var list = files.length ? "<ul class=\"file-list\">" + files.map(function (path) {
        var name = path.split(/[\\/]/).pop();
        return "<li><button type=\"button\" data-file=\"" + escapeHtml(path) + "\" data-category=\"" +
          escapeHtml(categoryLabels[category]) + "\">" + escapeHtml(name) + "</button></li>";
      }).join("") + "</ul>" : "<div class=\"empty\">No files</div>";
      return "<section class=\"file-group\"><h3>" + categoryLabels[category] + " (" + files.length + ")</h3>" + list + "</section>";
    }).join("");
    elements.suiteDialog.showModal();
    refreshSuiteModel();
  }

  function refreshSuiteModel() {
    if (!currentSuite) { return; }
    var sequence = ++modelRequest;
    var name = currentSuite.name;
    return api("/api/suite/model?suite=" + encodeURIComponent(name)).then(function (model) {
      var selected = (model.definitions || []).filter(function (definition) {
        return !activeDefinitionPath ||
          String(definition.path).replace(/\\/g, "/") === String(activeDefinitionPath).replace(/\\/g, "/");
      });
      return Promise.all(selected.map(function (definition) {
        return api("/api/config/common?suitePath=" + encodeURIComponent(definition.path)).catch(function (error) {
          return { properties: [], error: error.message };
        });
      })).then(function (commons) {
        var byPath = {};
        selected.forEach(function (definition, index) { byPath[definition.path] = commons[index]; });
        return { model: model, common: byPath };
      });
    }).then(function (response) {
      if (sequence !== modelRequest || !elements.suiteDialog.open) { return; }
      var drafts = {};
      var commonDrafts = {};
      var expressionDrafts = [];
      Array.prototype.forEach.call(elements.suiteModel.querySelectorAll("[data-expression-editor]"), function (editor) {
        var entry = modelFields[editor.getAttribute("data-expression-editor")];
        var input = editor.querySelector("textarea");
        if (entry && !editor.querySelector("[data-save-expression]").disabled &&
            input.value !== String(entry.field.value)) {
          expressionDrafts.push({ field: entry.field, value: input.value, editor: editor.cloneNode(true) });
        }
      });
      var sourceDrafts = [];
      Array.prototype.forEach.call(elements.suiteModel.querySelectorAll("[data-source-editor]"), function (editor) {
        var source = sourceDestinations[editor.getAttribute("data-source-editor")];
        var input = editor.querySelector("input");
        if (source && input && !editor.querySelector("[data-save-source]").disabled &&
            input.value !== String(source.value == null ? "" : source.value)) {
          sourceDrafts.push({ source: source, value: input.value, editor: editor.cloneNode(true) });
        }
      });
      Array.prototype.forEach.call(elements.suiteModel.querySelectorAll("[data-common-input]"), function (input) {
        var path = input.getAttribute("data-common-input");
        var index = Number(input.getAttribute("data-common-index"));
        var property = activeCommon && activeCommon[path] && activeCommon[path].properties[index];
        var values = property && property.values || [];
        var initial = property && !property.mixed && values.length ? String(values[0].value == null ? "" : values[0].value) : "";
        if (input.value !== initial) { commonDrafts[path + "|" + (property && property.name)] = input.value; }
      });
      Array.prototype.forEach.call(elements.suiteModel.querySelectorAll("[data-model-field]"), function (input) {
        var entry = modelFields[input.getAttribute("data-model-field")];
        if (!entry || input.disabled) { return; }
        var field = entry.field;
        var value = input.type === "checkbox" ? String(input.checked) : input.value;
        if (value !== String(field.value == null ? "" : field.value)) {
          drafts[field.sourcePath + "|" + field.nodePath + "|" + field.attribute + "|" + field.label] =
            { value: value, original: field.value, revision: field.revision };
        }
      });
      var opened = Array.prototype.map.call(elements.suiteModel.querySelectorAll(".test-object[open]"), function (node) {
        return node.querySelector(".test-object__title").textContent;
      });
      var technicalOpen = {};
      Array.prototype.forEach.call(elements.suiteModel.querySelectorAll("[data-technical-toggle][aria-expanded='true']"), function (button) {
        technicalOpen[button.getAttribute("aria-controls")] = true;
      });
      renderSuiteModel(response.model, activeDefinitionPath, response.common);
      Array.prototype.forEach.call(elements.suiteModel.querySelectorAll("[data-model-field]"), function (input) {
        var entry = modelFields[input.getAttribute("data-model-field")];
        if (!entry) { return; }
        var field = entry.field;
        var key = field.sourcePath + "|" + field.nodePath + "|" + field.attribute + "|" + field.label;
        if (!Object.prototype.hasOwnProperty.call(drafts, key)) { return; }
        var draft = drafts[key];
        if (input.type === "checkbox") { input.checked = draft.value === "true"; }
        else { input.value = draft.value; }
        if (field.value !== draft.original) { field.revision = draft.revision; }
      });
      Array.prototype.forEach.call(elements.suiteModel.querySelectorAll("[data-common-input]"), function (input) {
        var path = input.getAttribute("data-common-input");
        var index = Number(input.getAttribute("data-common-index"));
        var property = activeCommon && activeCommon[path] && activeCommon[path].properties[index];
        var draftKey = path + "|" + (property && property.name);
        if (Object.prototype.hasOwnProperty.call(commonDrafts, draftKey)) {
          input.value = commonDrafts[draftKey];
          input.closest(".common-property").querySelector("[data-common-preview]").disabled = false;
        }
      });
      if (opened.length) {
        Array.prototype.forEach.call(elements.suiteModel.querySelectorAll(".test-object"), function (node) {
          node.open = opened.indexOf(node.querySelector(".test-object__title").textContent) !== -1;
        });
      }
      Array.prototype.forEach.call(elements.suiteModel.querySelectorAll("[data-technical-toggle]"), function (button) {
        if (technicalOpen[button.getAttribute("aria-controls")]) {
          button.setAttribute("aria-expanded", "true");
          document.getElementById(button.getAttribute("aria-controls")).hidden = false;
        }
      });
      sourceDrafts.forEach(function (draft) {
        var button = Array.prototype.filter.call(elements.suiteModel.querySelectorAll("[data-edit-source]"), function (candidate) {
          var source = sourceDestinations[candidate.getAttribute("data-edit-source")];
          return source && source.sourcePath === draft.source.sourcePath &&
            source.nodePath === draft.source.nodePath && source.attribute === draft.source.attribute;
        })[0];
        if (!button) { return; }
        var id = button.getAttribute("data-edit-source");
        var editor = draft.editor;
        editor.setAttribute("data-source-editor", id);
        editor.querySelector("[data-save-source]").setAttribute("data-save-source", id);
        editor.querySelector("input").value = draft.value;
        if (sourceDestinations[id].value !== draft.source.value) {
          sourceDestinations[id] = draft.source;
          var error = editor.querySelector(".field-error");
          error.textContent = "The source changed while you were editing. Your draft is retained; reload and review before saving.";
          error.hidden = false;
        }
        button.closest("li").appendChild(editor);
        var owner = button.parentElement;
        while (owner && owner !== elements.suiteModel) {
          if (owner.tagName === "DETAILS") { owner.open = true; }
          owner = owner.parentElement;
        }
      });
      expressionDrafts.forEach(function (draft) {
        var button = Array.prototype.filter.call(elements.suiteModel.querySelectorAll("[data-edit-expression]"), function (candidate) {
          var entry = modelFields[candidate.getAttribute("data-edit-expression")];
          return entry && entry.field.sourcePath === draft.field.sourcePath &&
            entry.field.nodePath === draft.field.nodePath && entry.field.attribute === draft.field.attribute;
        })[0];
        var key = button ? button.getAttribute("data-edit-expression") : "field-" + (++modelFieldSequence);
        var changed = !button || modelFields[key].field.value !== draft.field.value;
        if (changed) { modelFields[key] = { field: draft.field }; }
        var editor = draft.editor;
        editor.setAttribute("data-expression-editor", key);
        editor.querySelector("[data-save-expression]").setAttribute("data-save-expression", key);
        editor.querySelector("textarea").value = draft.value;
        if (changed) {
          var error = editor.querySelector(".field-error");
          error.textContent = "The original XML field changed. Your expression draft is retained; reload and review before saving.";
          error.hidden = false;
        }
        var container = button && (button.closest(".parameter-value") || button.closest("li"));
        (container || elements.suiteModel).appendChild(editor);
        var owner = container;
        while (owner && owner !== elements.suiteModel) {
          if (owner.tagName === "DETAILS") { owner.open = true; }
          owner = owner.parentElement;
        }
      });
    }).catch(function (error) {
      if (sequence !== modelRequest) { return; }
      if (elements.suiteModel.querySelector(".definition-card")) {
        var refreshError = elements.suiteModel.querySelector("[data-refresh-error]");
        if (!refreshError) {
          refreshError = document.createElement("p");
          refreshError.className = "inline-error";
          refreshError.setAttribute("data-refresh-error", "");
          refreshError.setAttribute("role", "alert");
          elements.suiteModel.insertBefore(refreshError, elements.suiteModel.firstChild);
        }
        refreshError.textContent = "Could not refresh values. Your current edits are retained. " + error.message;
      } else {
        elements.suiteModel.innerHTML = "<div class=\"inline-error\">Unable to load suite configuration: " +
          escapeHtml(error.message) + "</div>";
      }
      showMessage(error.message, true);
    });
  }

  function suiteHasDrafts() {
    return Array.prototype.some.call(elements.suiteModel.querySelectorAll("[data-common-input]"), function (input) {
      var path = input.getAttribute("data-common-input");
      var property = activeCommon && activeCommon[path] &&
        activeCommon[path].properties[Number(input.getAttribute("data-common-index"))];
      var values = property && property.values || [];
      var initial = property && !property.mixed && values.length ? String(values[0].value == null ? "" : values[0].value) : "";
      return input.value !== initial;
    }) || Array.prototype.some.call(elements.suiteModel.querySelectorAll("[data-model-field]"), function (input) {
      var entry = modelFields[input.getAttribute("data-model-field")];
      return entry && (input.disabled ||
        (input.type === "checkbox" ? String(input.checked) : input.value) !== String(entry.field.value == null ? "" : entry.field.value));
    }) || Array.prototype.some.call(elements.suiteModel.querySelectorAll("[data-expression-editor]"), function (editor) {
      var entry = modelFields[editor.getAttribute("data-expression-editor")];
      return entry && editor.querySelector("textarea").value !== String(entry.field.value);
    }) || Array.prototype.some.call(elements.suiteModel.querySelectorAll("[data-source-editor]"), function (editor) {
      var source = sourceDestinations[editor.getAttribute("data-source-editor")];
      return source && editor.querySelector("input").value !== String(source.value == null ? "" : source.value);
    });
  }

  function editXmlExpression(button) {
    var key = button.getAttribute("data-edit-expression");
    var entry = modelFields[key];
    if (!entry || !expressionBacked(entry.field.value, entry.field.display)) { return; }
    var container = button.closest(".parameter-value") || button.closest("li");
    var existing = container.querySelector("[data-expression-editor]");
    if (existing) { existing.querySelector("textarea").focus(); return; }
    var editor = document.createElement("div");
    editor.className = "source-editor";
    editor.setAttribute("data-expression-editor", key);
    editor.innerHTML = "<label>Original XML expression<textarea rows=\"3\">" +
      escapeHtml(entry.field.value) + "</textarea></label>" +
      "<p class=\"field-help\">Only Save XML expression writes this source value. The resolved preview is never saved. " +
      "This XML field may be shared by other tests; expression evaluation cannot be checked fully until execution.</p>" +
      "<button class=\"button\" type=\"button\" data-save-expression=\"" + key + "\">Save XML expression</button>" +
      "<button class=\"button\" type=\"button\" data-cancel-expression>Cancel</button>" +
      "<p class=\"field-error\" role=\"alert\" hidden></p>";
    container.appendChild(editor);
    editor.querySelector("textarea").focus();
  }

  function saveXmlExpression(button) {
    var editor = button.closest("[data-expression-editor]");
    var entry = modelFields[button.getAttribute("data-save-expression")];
    if (!editor || !entry) { return; }
    var field = entry.field;
    var value = editor.querySelector("textarea").value;
    var errorLine = editor.querySelector(".field-error");
    errorLine.hidden = true;
    if (value === String(field.value)) { editor.remove(); return; }
    if (!expressionBacked(value)) {
      errorLine.textContent = "Keep an XML expression here. Use the advanced XML editor to deliberately replace it with a literal.";
      errorLine.hidden = false;
      return;
    }
    var suiteName = currentSuite && currentSuite.name;
    button.disabled = true;
    editor.querySelector("[data-cancel-expression]").disabled = true;
    api("/api/field", { method: "POST", body: JSON.stringify({
      sourcePath: field.sourcePath, nodePath: field.nodePath, attribute: field.attribute,
      value: value, revision: field.revision, editExpression: true
    }) }).then(function () {
      editor.remove();
      if (!elements.suiteDialog.open || !currentSuite || currentSuite.name !== suiteName) { return; }
      showMessage("XML expression saved; refreshing its display value.");
      return refreshSuiteModel();
    }).catch(function (error) {
      if (!editor.isConnected) { return; }
      errorLine.textContent = error.message;
      errorLine.hidden = false;
      button.disabled = false;
      editor.querySelector("[data-cancel-expression]").disabled = false;
    });
  }

  function editParameterSource(button) {
    var source = sourceDestinations[button.getAttribute("data-edit-source")];
    if (!source || !source.editable || expressionBacked(source.value) ||
        !source.sourcePath || !source.nodePath || !source.attribute || !source.revision) { return; }
    var listItem = button.closest("li");
    var existing = listItem.querySelector("[data-source-editor]");
    if (existing) { existing.querySelector("input").focus(); return; }
    var commonPath = activeCommon && Object.keys(activeCommon).filter(function (path) {
      return (activeCommon[path].properties || []).some(function (property) {
        return property.name === source.name && (property.files || []).some(function (file) {
          return String(file.path).replace(/\\/g, "/") ===
            String(source.sourcePath).replace(/\\/g, "/") && file.value === source.value;
        });
      });
    })[0];
    var common = commonPath && activeCommon[commonPath];
    var commonProperty = common && common.properties.filter(function (item) {
      return item.name === source.name;
    })[0];
    var commonInput = commonProperty && source.attribute === "constValue" && !commonProperty.mixed &&
      !(commonProperty.values || []).some(function (item) { return expressionBacked(item.value, item.display); }) &&
      Array.prototype.filter.call(elements.suiteModel.querySelectorAll("[data-common-input]"), function (input) {
        return input.getAttribute("data-common-input") === commonPath &&
          Number(input.getAttribute("data-common-index")) === common.properties.indexOf(commonProperty);
      })[0];
    if (commonInput) {
      commonInput.focus();
      commonInput.scrollIntoView({ block: "center" });
      showMessage("Review the shared common value change and its affected tests before applying.");
      return;
    }
    var fieldInput = Array.prototype.filter.call(elements.suiteModel.querySelectorAll("[data-model-field]"), function (input) {
      var fieldEntry = modelFields[input.getAttribute("data-model-field")];
      var field = fieldEntry && fieldEntry.field;
      return field && field.sourcePath === source.sourcePath && field.nodePath === source.nodePath &&
        field.attribute === source.attribute && !expressionBacked(field.value, field.display);
    })[0];
    if (fieldInput) {
      var owner = fieldInput.parentElement;
      while (owner && owner !== elements.suiteModel) {
        if (owner.tagName === "DETAILS") { owner.open = true; }
        if (owner.classList.contains("technical-details__panel")) {
          owner.hidden = false;
          var toggle = elements.suiteModel.querySelector("[data-technical-toggle='" + owner.id + "']");
          if (toggle) { toggle.setAttribute("aria-expanded", "true"); }
        }
        owner = owner.parentElement;
      }
      fieldInput.focus();
      fieldInput.scrollIntoView({ block: "center" });
      showMessage("Editing this literal source can affect all references to it. Changes use the field revision safeguard.");
      return;
    }
    var editor = document.createElement("div");
    editor.className = "source-editor";
    editor.setAttribute("data-source-editor", button.getAttribute("data-edit-source"));
    editor.innerHTML = "<label>Literal source value<input type=\"text\" value=\"" +
      escapeHtml(source.value) + "\"></label>" +
      "<p class=\"field-help\">This source may be shared by other tests. Saving changes only this literal XML leaf; dependent expressions remain unchanged. The file revision is checked before writing.</p>" +
      "<button class=\"button\" type=\"button\" data-save-source=\"" +
      escapeHtml(button.getAttribute("data-edit-source")) + "\">Save literal source</button>" +
      " <button class=\"button\" type=\"button\" data-cancel-source>Cancel</button>" +
      "<p role=\"alert\" class=\"field-error\" hidden></p>";
    listItem.appendChild(editor);
    editor.querySelector("input").focus();
  }

  function saveParameterSource(button) {
    var source = sourceDestinations[button.getAttribute("data-save-source")];
    var editor = button.closest("[data-source-editor]");
    if (!source || !editor || !source.editable || expressionBacked(source.value) || !source.revision) { return; }
    var value = editor.querySelector("input").value;
    var errorLine = editor.querySelector(".field-error");
    errorLine.hidden = true;
    if (expressionBacked(value)) {
      errorLine.textContent = "Edit literal source values here; use the advanced XML editor for expressions.";
      errorLine.hidden = false;
      return;
    }
    if (value === String(source.value == null ? "" : source.value)) { editor.remove(); return; }
    var sequence = modelRequest;
    var request = ++sourceRequest;
    var suiteName = currentSuite && currentSuite.name;
    button.disabled = true;
    api("/api/field", { method: "POST", body: JSON.stringify({
      sourcePath: source.sourcePath, nodePath: source.nodePath, attribute: source.attribute,
      value: value, revision: source.revision
    }) }).then(function () {
      if (!elements.suiteDialog.open || !currentSuite || currentSuite.name !== suiteName) { return; }
      editor.remove();
      showMessage("Literal source saved; refreshing dependent displays.");
      return refreshSuiteModel();
    }).catch(function (error) {
      if (sequence !== modelRequest || request !== sourceRequest || !editor.isConnected) { return; }
      errorLine.textContent = error.status === 409 ? "Source changed since loading. Refresh and retry. " + error.message : error.message;
      errorLine.hidden = false;
      button.disabled = false;
    });
  }
  function saveModelField(input, forcedValue) {
    var key = input.getAttribute("data-model-field");
    var entry = modelFields[key];
    if (!entry || expressionBacked(entry.field.value, entry.field.display)) { return; }
    var field = entry.field;
    var container = elements.suiteModel.querySelector("[data-model-container='" + key + "']");
    if (!container) { return; }
    var value = forcedValue === undefined ?
      (input.type === "checkbox" ? String(input.checked) : input.value) : String(forcedValue);
    if (value === String(field.value == null ? "" : field.value)) { return; }
    var sequence = modelRequest;
    var priorError = container.querySelector(".field-error");
    if (priorError) { priorError.remove(); }
    container.classList.remove("is-saved", "is-error");
    container.classList.add("is-saving");
    input.disabled = true;
    api("/api/field", {
      method: "POST",
      body: JSON.stringify({
        sourcePath: field.sourcePath,
        nodePath: field.nodePath,
        attribute: field.attribute,
        value: value,
        revision: field.revision
      })
    }).then(function (result) {
      if (sequence !== modelRequest) { return; }
      if (result.revision) {
        Object.keys(modelFields).forEach(function (otherKey) {
          if (modelFields[otherKey].field.sourcePath === field.sourcePath) {
            modelFields[otherKey].field.revision = result.revision;
          }
        });
      }
      field.value = value;
      container.classList.remove("is-saving");
      container.classList.add("is-saved");
      showMessage("Saved " + (field.label || field.attribute) + ".");
      return refreshSuiteModel();
    }).catch(function (error) {
      if (sequence !== modelRequest) { return; }
      container.classList.remove("is-saving");
      container.classList.add("is-error");
      if (forcedValue === undefined) {
        if (input.type === "checkbox") {
          input.checked = String(field.value).toLowerCase() === "true";
        } else {
          input.value = field.value == null ? "" : field.value;
        }
      }
      var errorLine = document.createElement("small");
      errorLine.className = "field-error";
      errorLine.setAttribute("role", "alert");
      errorLine.textContent = error.message;
      container.appendChild(errorLine);
      showMessage(error.message, true);
    }).then(function () {
      if (sequence === modelRequest && input.isConnected) { input.disabled = false; }
    });
  }

  function saveFilterLabels(key, values) {
    var entry = modelFields[key];
    if (!entry || !entry.test || !entry.test.nodePath) {
      showMessage("Reload the suite to edit filter labels safely.", true);
      return;
    }
    previewOperation({
      operation: "labels",
      suitePath: entry.field.sourcePath,
      testNodePath: entry.test.nodePath,
      labels: filterLabelValues(values.join(","))
    }, "Review selected test labels", refreshSuiteModel);
  }

  function addFilterLabels(key) {
    var input = elements.suiteModel.querySelector("[data-filter-label-input='" + key + "']");
    var additions = filterLabelValues(input.value);
    if (!additions.length) { return; }
    var selected = selectedFilterLabels(modelFields[key].test, modelFields[key].field);
    saveFilterLabels(key, selected.concat(additions));
  }

  function previewType(key, select) {
    var entry = modelFields[key];
    if (!entry) { return; }
    var field = entry.field;
    var initial = field.editorType || field.type || "string";
    if (select.value.toLowerCase() === String(initial).toLowerCase()) { return; }
    previewTypeValue(field.sourcePath, field.name || field.label, select);
    select.value = initial;
  }

  function previewTypeValue(sourcePath, name, select) {
    previewOperation({ operation: "type", sourcePath: sourcePath, name: name,
      editorType: select.value }, "Review parameter type and shared impact", refreshSuiteModel);
  }

  function timestampEditor(key) {
    return elements.suiteModel.querySelector("[data-timestamp='" + key + "']");
  }

  function timestampLocalValue(inputValue) {
    var match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(inputValue);
    if (!match) { return inputValue; }
    return match[1] + ":" + (match[2] || "00") + "." +
      ((match[3] || "") + "000").substring(0, 3);
  }

  function timestampFixed(key) {
    var editor = timestampEditor(key);
    if (!editor) { return; }
    editor.querySelector(".timestamp-fixed").hidden = false;
    editor.querySelector(".timestamp-switch").hidden = true;
    var raw = editor.querySelector("[data-model-field]").value.trim();
    if (/^-?\d+$/.test(raw)) {
      var sequence = modelRequest;
      api("/api/timestamp", { method: "POST", body: JSON.stringify({ epochMillis: raw }) })
        .then(function (time) {
          if (sequence !== modelRequest || !editor.isConnected) { return; }
          editor.querySelector("[data-timestamp-local]").value = time.localDateTime;
          editor.querySelector("[data-timestamp-offset]").value = time.offset;
          previewTimestamp(key);
        }).catch(function (error) {
          if (sequence !== modelRequest || !editor.isConnected) { return; }
          editor.querySelector("[data-timestamp-preview]").textContent = error.message;
        });
    } else {
      editor.querySelector("[data-timestamp-preview]").textContent =
        "Expression preserved. Enter a local date and time to replace it explicitly.";
    }
    editor.querySelector("[data-timestamp-local]").focus();
  }

  function previewTimestamp(key) {
    var editor = timestampEditor(key);
    if (!editor) { return; }
    var local = timestampLocalValue(editor.querySelector("[data-timestamp-local]").value);
    var offset = editor.querySelector("[data-timestamp-offset]").value;
    var output = editor.querySelector("[data-timestamp-preview]");
    var save = editor.querySelector("[data-timestamp-save]");
    save.disabled = true;
    editor.removeAttribute("data-epoch-millis");
    if (!local) { output.textContent = "Enter a local date and time."; return; }
    var request = ++timestampRequest;
    var sequence = modelRequest;
    output.textContent = "Checking Europe/Vilnius time...";
    api("/api/timestamp", { method: "POST", body: JSON.stringify({
      localDateTime: local, offset: offset || undefined
    }) }).then(function (time) {
      if (request !== timestampRequest || sequence !== modelRequest || !editor.isConnected) { return; }
      editor.setAttribute("data-epoch-millis", time.epochMillis);
      output.textContent = "Stored value: " + time.epochMillis + " ms · " +
        time.localDateTime + " " + time.offset + " " + time.zone;
      save.disabled = false;
    }).catch(function (error) {
      if (request !== timestampRequest || sequence !== modelRequest || !editor.isConnected) { return; }
      output.textContent = error.message +
        (offset ? "" : " For an autumn overlap, select UTC+02:00 or UTC+03:00 explicitly.");
    });
  }

  function commonTimestampEditor(id) {
    return elements.suiteModel.querySelector("[data-common-timestamp='" + id + "']");
  }

  function previewCommonTimestamp(id) {
    var editor = commonTimestampEditor(id);
    if (!editor) { return; }
    var local = timestampLocalValue(editor.querySelector("[data-common-time-local]").value);
    var offset = editor.querySelector("[data-common-time-offset]").value;
    var output = editor.querySelector("[data-common-time-preview]");
    var button = editor.querySelector("[data-common-time-use]");
    editor.removeAttribute("data-epoch-millis");
    button.disabled = true;
    if (!local) { output.textContent = "Choose a local time."; return; }
    var request = ++timestampRequest;
    var sequence = modelRequest;
    output.textContent = "Checking Europe/Vilnius time...";
    api("/api/timestamp", { method: "POST", body: JSON.stringify({
      localDateTime: local, offset: offset || undefined
    }) }).then(function (time) {
      if (request !== timestampRequest || sequence !== modelRequest || !editor.isConnected) { return; }
      editor.setAttribute("data-epoch-millis", time.epochMillis);
      output.textContent = time.localDateTime + " " + time.offset + " · " +
        time.epochMillis + " milliseconds";
      button.disabled = false;
    }).catch(function (error) {
      if (request !== timestampRequest || sequence !== modelRequest || !editor.isConnected) { return; }
      output.textContent = error.message +
        (offset ? "" : " If this is an autumn overlap, select an offset explicitly.");
    });
  }

  function builderDefinition() {
    return (activeModel.definitions || []).filter(function (definition) {
      return definition.path === elements.testBuilderDestination.value;
    })[0];
  }

  function builderSource() {
    var definition = builderDefinition();
    return definition && (definition.tests || []).filter(function (test) {
      return test.nodePath === elements.testBuilderSource.value;
    })[0];
  }

  function updateBuilderExamples(preferredNodePath) {
    var definition = builderDefinition();
    elements.testBuilderSource.innerHTML = definition ? (definition.tests || []).map(function (test) {
      return "<option value=\"" + escapeHtml(test.nodePath || "") + "\"" +
        (preferredNodePath === test.nodePath ? " selected" : "") + ">" +
        escapeHtml(test.name) + (test.methods && test.methods.length ? " · " +
          escapeHtml(test.methods.join(", ")) : "") + "</option>";
    }).join("") : "";
    updateBuilderDetails();
  }

  function updateBuilderDetails() {
    var source = builderSource();
    if (!source) {
      elements.testBuilderDetails.textContent = "Choose a suite definition with an existing compatible example.";
      elements.testBuilderPreview.disabled = true;
      return;
    }
    elements.testBuilderPreview.disabled = false;
    elements.testBuilderMethod.value = (source.methods || []).join(", ");
    var templates = (source.scenarios || []).map(function (scenario) {
      return scenario.references && scenario.references.templatePath;
    }).filter(Boolean);
    elements.testBuilderTemplate.value = templates.length ? templates.filter(function (path, i) {
      return templates.indexOf(path) === i;
    }).join(", ") : "No request template referenced";
    elements.testBuilderDetails.innerHTML = "<strong>Example: " + escapeHtml(source.name) + "</strong>" +
      "<p>Method: " + escapeHtml((source.methods || []).join(", ") || "Defined in suite XML") +
      "<br>Input: <code>" + escapeHtml(source.inputPath || "None") + "</code>" +
      "<br>Selected scenarios: " + (source.scenarios || []).length +
      (source.userDefinition ? " · User definition" : " · Test case") + "</p>" +
      "<p>New input and validation files are independent; remaining shared templates are listed in review.</p>";
  }

  function openTestBuilder(kind, definitionPath, sourcePath) {
    if (!activeModel) { return; }
    builderKind = kind;
    elements.testBuilderForm.reset();
    elements.testBuilderTitle.textContent = kind === "duplicate" ? "Duplicate test independently" : "Add test";
    elements.testBuilderIntro.textContent = kind === "duplicate"
      ? "Create a separate suite test with its own input scenarios and validations. The original remains unchanged."
      : "Choose a compatible existing example and create a new test with independently editable input and validations.";
    elements.testBuilderDestination.innerHTML = (activeModel.definitions || []).map(function (definition) {
      return "<option value=\"" + escapeHtml(definition.path) + "\"" +
        (definition.path === definitionPath ? " selected" : "") + ">" +
        escapeHtml(definition.name) + " · " + escapeHtml(definition.path) + "</option>";
    }).join("");
    updateBuilderExamples(sourcePath);
    var source = builderSource();
    elements.testBuilderName.value = source ? source.name + (kind === "duplicate" ? " Copy" : " New") : "";
    elements.testBuilderLabels.value = source ?
      selectedFilterLabels(source, { value: source.label }).join(", ") : "";
    elements.testBuilderPosition.value = kind === "duplicate" ? "after" : "beforeCleanup";
    elements.testBuilderState.textContent = "No files changed";
    elements.testBuilderDialog.showModal();
    elements.testBuilderName.focus();
  }

  function previewTestBuilder(event) {
    event.preventDefault();
    var source = builderSource();
    if (!source || !elements.testBuilderForm.reportValidity()) { return; }
    var payload = {
      operation: "create",
      kind: builderKind,
      suitePath: elements.testBuilderDestination.value,
      sourceTestNodePath: source.nodePath,
      name: elements.testBuilderName.value.trim(),
      position: elements.testBuilderPosition.value
    };
    previewOperation(payload, (builderKind === "duplicate" ? "Review independent duplicate" : "Review new test"),
      function () {
        elements.testBuilderDialog.close();
        return refreshSuiteModel().then(function () { return loadState(); });
      });
  }

  function openFile(path, category) {
    var sequence = ++fileRequest;
    api("/api/file?path=" + encodeURIComponent(path)).then(function (data) {
      if (sequence !== fileRequest) { return; }
      currentFile = data.path;
      elements.editorCategory.textContent = category;
      elements.editorTitle.textContent = currentFile.split(/[\\/]/).pop();
      elements.editorPath.textContent = currentFile;
      elements.fileEditor.value = data.content;
      elements.editorState.textContent = "No unsaved changes";
      elements.editorDialog.showModal();
    }).catch(function (error) {
      if (sequence === fileRequest) { showMessage(error.message, true); }
    });
  }

  function saveFile() {
    var path = currentFile;
    var content = elements.fileEditor.value;
    var sequence = fileRequest;
    elements.saveFile.disabled = true;
    elements.fileEditor.disabled = true;
    elements.editorState.textContent = "Validating and saving...";
    api("/api/file", {
      method: "PUT",
      body: JSON.stringify({ path: path, content: content })
    }).then(function () {
      if (sequence !== fileRequest) { return; }
      elements.editorState.textContent = "Saved";
      showMessage("Saved " + path + ".");
      if (elements.suiteDialog.open) { refreshSuiteModel(); }
    }).catch(function (error) {
      if (sequence !== fileRequest) { return; }
      elements.editorState.textContent = "Save failed";
      showMessage(error.message, true);
    }).then(function () {
      if (sequence === fileRequest) {
        elements.saveFile.disabled = false;
        elements.fileEditor.disabled = false;
      }
    });
  }

  function targetByName(name) {
    return (state.targets || []).filter(function (target) { return target.name === name; })[0];
  }

  function runTarget(name) {
    var target = targetByName(name);
    var environmentLabel = target.environment === "Default"
      ? "Default configuration (" + state.selectedEnvironment + ")"
      : target.environment;
    if (!window.confirm("Run Ant target " + target.name + " using " + environmentLabel + "?")) {
      return;
    }
    api("/api/run", {
      method: "POST",
      body: JSON.stringify({ target: name })
    }).then(function () {
      showMessage("Started target " + target.name + " using " + environmentLabel + ".");
      updateRunStatus();
    }).catch(function (error) { showMessage(error.message, true); });
  }

  function updateTargetEnvironment(targetName, environment, select) {
    select.disabled = true;
    api("/api/target/environment", {
      method: "POST",
      body: JSON.stringify({ target: targetName, environment: environment })
    }).then(function () {
      var target = targetByName(targetName);
      target.environment = environment;
      target.effectiveEnvironment = environment === "Default" ? state.selectedEnvironment : environment;
      showMessage(environment === "Default"
        ? "Target " + targetName + " will use the Default configuration (" + state.selectedEnvironment + ")."
        : "Target " + targetName + " will run in " + environment + ".");
    }).catch(function (error) {
      select.value = targetByName(targetName).environment;
      showMessage(error.message, true);
    }).then(function () {
      select.disabled = false;
    });
  }

  function renderTargetSuiteOptions() {
    var query = elements.targetSuiteSearch.value.trim().toLowerCase();
    var files = (state.availableSuiteFiles || []).filter(function (path) {
      return path.toLowerCase().indexOf(query) !== -1;
    });
    elements.targetSuiteFiles.innerHTML = files.map(function (path) {
      return "<label class=\"target-suite-option\"><input type=\"checkbox\" name=\"target-suite\" value=\"" +
        escapeHtml(path) + "\"" + (targetSuiteSelection[path] ? " checked" : "") +
        "><span title=\"" + escapeHtml(path) + "\">" +
        escapeHtml(displaySuitePath(path)) + "</span></label>";
    }).join("");
    updateTargetSuiteCount();
  }

  function updateTargetSuiteCount() {
    var count = Object.keys(targetSuiteSelection).filter(function (path) {
      return targetSuiteSelection[path];
    }).length;
    elements.targetSuiteCount.textContent = count + " selected";
  }

  function openTargetBuilder() {
    currentTarget = null;
    targetSuiteSelection = {};
    elements.targetForm.reset();
    elements.targetEnvironment.innerHTML = "<option value=\"Default\">Default</option>" +
      state.environments.map(function (environment) {
      return "<option value=\"" + escapeHtml(environment.name) + "\"" +
        (environment.name === state.selectedEnvironment ? " selected" : "") + ">" +
        escapeHtml(environment.name) + "</option>";
    }).join("");
    elements.targetSuiteSearch.value = "";
    renderTargetSuiteOptions();
    elements.targetDialog.showModal();
  }

  function createTarget(event) {
    event.preventDefault();
    var suites = Object.keys(targetSuiteSelection).filter(function (path) {
      return targetSuiteSelection[path];
    });
    if (!suites.length) {
      showMessage("Select at least one suite definition.", true);
      return;
    }
    elements.saveTarget.disabled = true;
    api("/api/target", {
      method: "POST",
      body: JSON.stringify({
        name: elements.targetName.value.trim(),
        description: elements.targetDescription.value.trim(),
        environment: elements.targetEnvironment.value,
        suites: suites
      })
    }).then(function () {
      elements.targetDialog.close();
      showMessage("Created Ant target " + elements.targetName.value.trim() + ".");
      return loadState();
    }).catch(function (error) {
      showMessage(error.message, true);
    }).then(function () {
      elements.saveTarget.disabled = false;
    });
  }

  function updateRunStatus() {
    return api("/api/run/status").then(function (run) {
      document.getElementById("report-run-warning").hidden = !run.running;
      window.clearTimeout(pollTimer);
      if (!run.suite) {
        elements.runBanner.hidden = true;
        return;
      }
      elements.runBanner.hidden = false;
      elements.runBanner.classList.toggle("is-complete", !run.running && run.exitCode === 0);
      elements.runBanner.classList.toggle("is-failed", !run.running && run.exitCode !== 0);
      elements.runTitle.textContent = run.running ? "Test execution in progress" :
        (run.exitCode === 0 ? "Test execution completed" : "Test execution failed");
      elements.runSubtitle.textContent = (run.target || run.suite) + " · " + run.environment +
        (run.running ? "" : " · Exit code " + run.exitCode);
      elements.runLog.textContent = run.log || "No output yet.";
      if (run.running) {
        pollTimer = window.setTimeout(updateRunStatus, 1500);
      } else {
        state.reportAvailable = run.exitCode === 0 || state.reportAvailable;
        renderReport();
      }
    }).catch(function (error) {
      showMessage("Unable to read run status: " + error.message, true);
    });
  }

  var reportView = window.ChargingReport.create(document.getElementById("report-screen"));
  elements.environmentSelect.addEventListener("click", function () {
    if (elements.environmentPopup.hidden) { openEnvironmentPicker(); } else { closeEnvironmentPicker(true); }
  });
  elements.environmentSelect.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openEnvironmentPicker(); }
  });
  ["previous", "next"].forEach(function (direction) {
    document.getElementById("environment-preview-" + direction).addEventListener("click", function () {
      if (!state || environmentSaving || !state.environments.length) { return; }
      var length = state.environments.length;
      previewEnvironmentDetails((previewEnvironment + (direction === "next" ? 1 : length - 1)) % length);
    });
  });
  elements.environmentPicker.addEventListener("keydown", environmentPickerKeydown);
  elements.environmentOptions.addEventListener("pointerover", function (event) {
    var option = event.target.closest("[data-environment-index]");
    if (option && !environmentSaving && event.pointerType !== "touch") {
      previewEnvironmentDetails(Number(option.getAttribute("data-environment-index")));
    }
  });
  elements.environmentOptions.addEventListener("click", function (event) {
    var option = event.target.closest("[data-environment-index]");
    if (option) { selectEnvironment(state.environments[Number(option.getAttribute("data-environment-index"))].name); }
  });
  elements.environmentPicker.addEventListener("focusout", function () {
    window.setTimeout(function () {
      if (!elements.environmentPicker.contains(document.activeElement)) { closeEnvironmentPicker(false); }
    }, 0);
  });
  document.addEventListener("pointerdown", function (event) {
    if (!elements.environmentPicker.contains(event.target)) { closeEnvironmentPicker(false); }
  });
  elements.openTestsConfiguration.addEventListener("click", openTestsConfiguration);
  elements.backToHome.addEventListener("click", backToHome);
  window.addEventListener("hashchange", renderScreen);
  elements.suiteSearch.addEventListener("input", renderTargets);
  elements.suiteConfigSearch.addEventListener("input", renderSuiteConfiguration);
  elements.openReport.addEventListener("click", function () { window.location.hash = "report"; });
  document.getElementById("report-back").addEventListener("click", backToHome);
  elements.suiteList.addEventListener("click", function (event) {
    var suitePathButton = event.target.closest("[data-suite-path]");
    if (suitePathButton) {
      var suitePath = suitePathButton.getAttribute("data-suite-path");
      openSuite(suiteFolderFromPath(suitePath), suitePath);
      return;
    }
    var actionButton = event.target.closest("[data-action]");
    if (!actionButton) { return; }
    var action = actionButton.getAttribute("data-action");
    var targetName = actionButton.closest(".suite-row").getAttribute("data-target");
    if (action === "run-target") { runTarget(targetName); }
  });
  elements.suiteList.addEventListener("change", function (event) {
    if (event.target.hasAttribute("data-target-environment")) {
      updateTargetEnvironment(
        event.target.closest(".suite-row").getAttribute("data-target"),
        event.target.value,
        event.target
      );
    }
  });
  elements.suiteConfigList.addEventListener("click", function (event) {
    var actionButton = event.target.closest("[data-action='configure-suite']");
    if (actionButton) {
      openSuite(actionButton.closest(".suite-row").getAttribute("data-suite"));
    }
  });
  elements.suiteFileGroups.addEventListener("click", function (event) {
    if (event.target.hasAttribute("data-file")) {
      openFile(event.target.getAttribute("data-file"), event.target.getAttribute("data-category"));
    }
  });
  elements.suiteModel.addEventListener("change", function (event) {
    if (event.target.hasAttribute("data-model-field")) {
      saveModelField(event.target);
    } else if (event.target.hasAttribute("data-type-field")) {
      previewType(event.target.getAttribute("data-type-field"), event.target);
    } else if (event.target.hasAttribute("data-common-suite-type")) {
      var typeSetting = event.target.closest(".common-type-setting");
      typeSetting.querySelector("[data-common-type-preview]").disabled = !event.target.value;
      var typeProperty = event.target.closest(".common-property");
      var typeTimestamp = typeProperty.querySelector("[data-common-timestamp]");
      typeTimestamp.hidden = !typeProperty.querySelector("[data-common-input]") ||
        (event.target.value !== "unixTimestamp" &&
        typeTimestamp.getAttribute("data-common-timestamp-base") !== "true");
    } else if (event.target.hasAttribute("data-common-time-local") ||
               event.target.hasAttribute("data-common-time-offset")) {
      previewCommonTimestamp(event.target.getAttribute("data-common-time-local") ||
        event.target.getAttribute("data-common-time-offset"));
    } else if (event.target.hasAttribute("data-timestamp-local") ||
               event.target.hasAttribute("data-timestamp-offset")) {
      previewTimestamp(event.target.getAttribute("data-timestamp-local") ||
        event.target.getAttribute("data-timestamp-offset"));
    }
  });
  elements.suiteModel.addEventListener("input", function (event) {
    if (event.target.hasAttribute("data-timestamp-local")) {
      previewTimestamp(event.target.getAttribute("data-timestamp-local"));
    } else if (event.target.hasAttribute("data-common-time-local")) {
      previewCommonTimestamp(event.target.getAttribute("data-common-time-local"));
    } else if (event.target.hasAttribute("data-common-input")) {
      event.target.closest(".common-property").querySelector("[data-common-preview]").disabled = false;
    }
  });
  elements.suiteModel.addEventListener("click", function (event) {
    var expressionFiles = event.target.closest("[data-expression-files]");
    if (expressionFiles) {
      var fileDetails = document.getElementById(expressionFiles.getAttribute("data-expression-files"));
      fileDetails.open = true;
      var fileEditors = fileDetails.querySelectorAll("[data-edit-expression]");
      if (fileEditors.length === 1) { editXmlExpression(fileEditors[0]); }
      else { fileDetails.querySelector("summary").focus(); }
      return;
    }
    var expressionEdit = event.target.closest("[data-edit-expression]");
    if (expressionEdit) { editXmlExpression(expressionEdit); return; }
    var expressionSave = event.target.closest("[data-save-expression]");
    if (expressionSave) { saveXmlExpression(expressionSave); return; }
    var expressionCancel = event.target.closest("[data-cancel-expression]");
    if (expressionCancel) { expressionCancel.closest("[data-expression-editor]").remove(); return; }
    var technicalToggle = event.target.closest("[data-technical-toggle]");
    if (technicalToggle) {
      var technicalPanel = document.getElementById(technicalToggle.getAttribute("aria-controls"));
      if (technicalPanel) {
        technicalPanel.hidden = !technicalPanel.hidden;
        technicalToggle.setAttribute("aria-expanded", String(!technicalPanel.hidden));
      }
      return;
    }
    var sourceEdit = event.target.closest("[data-edit-source]");
    if (sourceEdit) { editParameterSource(sourceEdit); return; }
    var sourceSave = event.target.closest("[data-save-source]");
    if (sourceSave) { saveParameterSource(sourceSave); return; }
    var sourceCancel = event.target.closest("[data-cancel-source]");
    if (sourceCancel) { sourceCancel.closest("[data-source-editor]").remove(); return; }
    if (event.target.closest("[data-year-source]")) {
      if (suiteHasDrafts()) {
        showMessage("Save or cancel pending suite edits before opening shared CURRENT_YEAR configuration.", true);
        return;
      }
      elements.suiteDialog.close();
      loadYear().then(function () {
        var control = document.getElementById("year-mode");
        if (control) {
          var panel = control.closest("details");
          if (panel) { panel.open = true; }
          control.focus();
        }
      });
      return;
    }
    var commonTimeSwitch = event.target.closest("[data-common-time-switch]");
    if (commonTimeSwitch) {
      var id = commonTimeSwitch.getAttribute("data-common-time-switch");
      var timeEditor = commonTimestampEditor(id);
      commonTimeSwitch.hidden = true;
      timeEditor.querySelector("div").hidden = false;
      var original = elements.suiteModel.querySelector("[id='" + id + "']").value.trim();
      if (/^-?\d+$/.test(original)) {
        var sequence = modelRequest;
        api("/api/timestamp", { method: "POST", body: JSON.stringify({ epochMillis: original }) })
          .then(function (time) {
            if (sequence !== modelRequest || !timeEditor.isConnected) { return; }
            timeEditor.querySelector("[data-common-time-local]").value = time.localDateTime;
            timeEditor.querySelector("[data-common-time-offset]").value = time.offset;
            previewCommonTimestamp(id);
          }).catch(function (error) {
            if (sequence === modelRequest && timeEditor.isConnected) {
              timeEditor.querySelector("[data-common-time-preview]").textContent = error.message;
            }
          });
      } else {
        timeEditor.querySelector("[data-common-time-preview]").textContent =
          "Existing expression is unchanged. Choose a fixed time explicitly.";
      }
      return;
    }
    var commonTimeUse = event.target.closest("[data-common-time-use]");
    if (commonTimeUse) {
      var commonId = commonTimeUse.getAttribute("data-common-time-use");
      var commonEditor = commonTimestampEditor(commonId);
      var millis = commonEditor.getAttribute("data-epoch-millis");
      if (millis != null) {
        var valueInput = elements.suiteModel.querySelector("[id='" + commonId + "']");
        valueInput.value = millis;
        valueInput.closest(".common-property").querySelector("[data-common-preview]").disabled = false;
        commonEditor.querySelector("[data-common-time-preview]").textContent =
          "Entered " + millis + " milliseconds. Review and apply to all affected tests to save.";
      }
      return;
    }
    var commonButton = event.target.closest("[data-common-preview]");
    if (commonButton) {
      var path = commonButton.getAttribute("data-common-path");
      var index = Number(commonButton.getAttribute("data-common-preview"));
      var property = activeCommon && activeCommon[path] &&
        activeCommon[path].properties[index];
      var input = elements.suiteModel.querySelector("[data-common-input='" + path +
        "'][data-common-index='" + index + "']");
      if (property && input && !expressionBacked(
          (property.values || [])[0] && property.values[0].value, property.display) &&
          !((property.values || []).some(function (item) { return expressionBacked(item.value, item.display); }) ||
          (property.files || []).some(function (item) { return expressionBacked(item.value, item.display); }))) {
        previewOperation({ operation: "common", suitePath: path, name: property.name,
          value: input.value }, "Review shared " + property.name, refreshSuiteModel);
      }
      return;
    }
    var commonTypeButton = event.target.closest("[data-common-type-preview]");
    if (commonTypeButton) {
      var typePath = commonTypeButton.getAttribute("data-common-path");
      var typeIndex = Number(commonTypeButton.getAttribute("data-common-type-preview"));
      var typeProperty = activeCommon && activeCommon[typePath] &&
        activeCommon[typePath].properties[typeIndex];
      var typeCard = commonTypeButton.closest(".common-property");
      var typeSelect = typeCard.querySelector("[data-common-suite-type]");
      if (typeProperty && typeSelect.value) {
        var protectedValues = (typeProperty.values || []).some(function (item) { return expressionBacked(item.value, item.display); }) ||
          (typeProperty.files || []).some(function (item) { return expressionBacked(item.value, item.display); });
        var replace = !protectedValues && typeCard.querySelector("[data-common-type-replace]").checked;
        var typePayload = { operation: "common-type", suitePath: typePath, name: typeProperty.name,
          editorType: typeSelect.value };
        if (replace) { typePayload.value = typeCard.querySelector("[data-common-input]").value; }
        previewOperation(typePayload, "Review shared " + typeProperty.name +
          " type across all XMLs", refreshSuiteModel,
          { files: typeProperty.files || [], replaceValue: replace });
      }
      return;
    }
    var addTest = event.target.closest("[data-add-test]");
    if (addTest) {
      openTestBuilder("guided", addTest.getAttribute("data-add-test"));
      return;
    }
    var duplicate = event.target.closest("[data-duplicate-test]");
    if (duplicate) {
      var definition = duplicate.closest(".definition-card");
      openTestBuilder("duplicate", definition.querySelector(".definition-card__header code").textContent,
        duplicate.getAttribute("data-duplicate-test"));
      return;
    }
    var switchTime = event.target.closest("[data-timestamp-switch]");
    if (switchTime) {
      timestampFixed(switchTime.getAttribute("data-timestamp-switch"));
      return;
    }
    var saveTime = event.target.closest("[data-timestamp-save]");
    if (saveTime) {
      var keyTime = saveTime.getAttribute("data-timestamp-save");
      var editorTime = timestampEditor(keyTime);
      var epoch = editorTime.getAttribute("data-epoch-millis");
      if (epoch != null && modelFields[keyTime] &&
          !expressionBacked(modelFields[keyTime].field.value, modelFields[keyTime].field.display)) {
        var rawTime = editorTime.querySelector("[data-model-field]");
        saveModelField(rawTime, epoch);
      }
      return;
    }
    var addButton = event.target.closest("[data-add-filter-label]");
    if (addButton) {
      addFilterLabels(addButton.getAttribute("data-add-filter-label"));
      return;
    }
    var removeButton = event.target.closest("[data-remove-filter-label]");
    if (removeButton) {
      var key = removeButton.getAttribute("data-remove-filter-label");
      var selected = selectedFilterLabels(modelFields[key].test, modelFields[key].field);
      var values = selected.slice();
      values.splice(Number(removeButton.getAttribute("data-filter-label-index")), 1);
      saveFilterLabels(key, values);
    }
  });
  elements.suiteModel.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && event.target.hasAttribute("data-filter-label-input")) {
      event.preventDefault();
      addFilterLabels(event.target.getAttribute("data-filter-label-input"));
    }
  });
  elements.createTarget.addEventListener("click", openTargetBuilder);
  elements.testBuilderDestination.addEventListener("change", function () { updateBuilderExamples(); });
  elements.testBuilderSource.addEventListener("change", updateBuilderDetails);
  elements.testBuilderForm.addEventListener("submit", previewTestBuilder);
  elements.reviewConfirm.addEventListener("change", function () {
    elements.reviewCommit.disabled = !this.checked || !activeReview || !activeReview.preview;
  });
  elements.reviewCommit.addEventListener("click", commitReview);
  elements.targetForm.addEventListener("submit", createTarget);
  elements.targetSuiteSearch.addEventListener("input", renderTargetSuiteOptions);
  elements.targetSuiteFiles.addEventListener("change", function (event) {
    if (event.target.name === "target-suite") {
      targetSuiteSelection[event.target.value] = event.target.checked;
      updateTargetSuiteCount();
    }
  });
  elements.saveFile.addEventListener("click", saveFile);
  elements.fileEditor.addEventListener("input", function () { elements.editorState.textContent = "Unsaved changes"; });
  elements.showRunLog.addEventListener("click", function () {
    updateRunStatus().then(function () { elements.logDialog.showModal(); });
  });
  document.querySelectorAll("[data-close-dialog]").forEach(function (button) {
    button.addEventListener("click", function () {
      document.getElementById(this.getAttribute("data-close-dialog")).close();
    });
  });
  document.querySelectorAll("dialog").forEach(function (dialog) {
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) { dialog.close(); }
    });
  });
  elements.suiteDialog.addEventListener("close", function () {
    if (elements.suiteDialog.open) { return; }
    ++modelRequest;
    activeModel = null;
    activeCommon = null;
  });
  elements.editorDialog.addEventListener("close", function () {
    if (elements.editorDialog.open) { return; }
    ++fileRequest;
    currentFile = null;
  });

  renderScreen();
  loadState();
}());
