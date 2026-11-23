(async function () {
  "use strict";
  var passed = [], failures = [];
  function check(condition, message) {
    if (!condition) { throw new Error(message); }
    passed.push(message);
  }
  function throws(action, message) {
    var rejected = false;
    try { action(); } catch (error) { rejected = true; }
    check(rejected, message);
  }
  async function until(condition, message) {
    var end = Date.now() + 6000;
    while (!condition()) {
      if (Date.now() > end) { throw new Error(message); }
      await new Promise(function (resolve) { setTimeout(resolve, 20); });
    }
  }
  function overview() {
    var html = '<p>Report created at: 2026-01-02T03:04:05 | Total duration: 3.0 s</p>';
    ["suites", "tests", "scenarios"].forEach(function (kind) {
      [kind === "suites" ? 1 : 2, 1, kind === "suites" ? 0 : 1, 0].forEach(function (n, i) {
        html += '<button id="btn_' + ["all", "passed", "failed", "skipped"][i] + "_" + kind + '">' + n + "</button>";
      });
    });
    return html + '<div id="_SUITE-PASSED-1"><table><tr><th>1 Suite &amp; example</th></tr><tr><td>3.0 s</td></tr>' +
      '<tr id="_TEST-PASSED-1-SUITE-1"><td><a>1 First<div>1.0 s</div></a></td><td>1</td><td>0</td><td>0</td></tr>' +
      '<tr id="_TEST-PASSED-1-SUITE-1-LINK-L1-1"><td><button onclick="window.open(\'./first.htm\')">Detail</button></td></tr>' +
      '<tr id="_TEST-FAILED-2-SUITE-1"><td><a>2 Second<div>2.0 s</div></a></td><td>0</td><td>1</td><td>0</td></tr>' +
      '<tr id="_TEST-FAILED-2-SUITE-1-LINK-L1-1"><td><button onclick="window.open(\'./second.htm\')">Detail</button></td></tr>' +
      "</table></div>";
  }
  var detail = '<div id="_TEST-FAILED-1"><p>method [param set id: 42]</p>' +
    '<button id="log_btn_1" onclick="window.open(\'./scenario/930_42.htm\')">FAILED</button>' +
    '<div id="_DESCRIPTION-1-DETAIL">Example &lt;value&gt;</div>' +
    '<div id="_STACKTRACE-1-DETAIL">Stacktrace:<br>AssertionError<br>expected &lt;1&gt; but found 0' +
    '<br>Validation failed for<br>validation item: Charged item validation;<br>expected number of CIT(s): 1, but found: 0' +
    '<br>CIT filter: {<br>classId equals &lt;MUSG&gt; AND<br>amount equals 1<br>}<br>' +
    '<table><tr><th>CIT filter</th><th>field</th><th>rule</th><th>expected value</th><th>operation</th>' +
    '<th>num. of matched CIT(s)</th><th>matched cit#id list</th><th>values in CIT(s)</th></tr>' +
    '<tr><td>1.</td><td>classId</td><td>equals</td><td>&lt;MUSG&gt;</td><td>AND</td><td>0</td>' +
    '<td>NO_MATCHED_CITS</td><td>&lt;img src=x onerror=alert(1)&gt;</td></tr></table>' +
    ' expected [true] but found [false]<br>\tat org.example.Assert.fail(Assert.java:1)<br>... 2 more</div></div>';
  var citComparisons = [
    { expected: "HOME", actual: "123: [ROAM]", mismatch: true, label: "different bracketed text" },
    { expected: "HOME", actual: "123: [ HOME ]", mismatch: false, label: "equal text with padding despite zero matches" },
    { expected: "0.001269", actual: "123: [0.001074]", mismatch: true, label: "different decimal values" },
    { expected: "HOME", actual: "123: [HOME]\n456: [ROAM]", mismatch: true, label: "one different value among multiple CITs" },
    { expected: "HOME", actual: "123: [HOME]\n456: [HOME]", mismatch: false, label: "multiple equal CIT values" },
    { expected: "HOME", actual: "NO_MATCHED_CITS", mismatch: false, label: "no bracketed value" },
    { expected: "HOME", actual: "123: []", mismatch: true, label: "empty value differs from nonempty expected" },
    { expected: "", actual: "123: []", mismatch: false, label: "empty expected and actual values" }
  ];
  detail = detail.replace("</table>", citComparisons.map(function (item, index) {
    return "<tr><td>" + (index + 2) + ".</td><td>field</td><td>equals</td><td>" + item.expected +
      "</td><td>AND</td><td>0</td><td>NO_MATCHED_CITS</td><td>" + item.actual + "</td></tr>";
  }).join("") + "</table>");
  var url = location.origin + "/report/example/Report.htm", html = overview();
  var frame = null, frameUrl = null;
  try {
    var report = ChargingReport.parseOverview(html, url);
    check(report.tests.total === 2 && report.tests.failed === 1 && report.scenarios.passed === 1, "Extract test and scenario counts");
    check(report.suites[0].tests.length === 2, "Nested link rows are not tests");
    check(report.suites[0].name === "Suite & example", "Decode labels without markup");
    check(report.suites[0].status === "passed" && report.warnings.length === 0 &&
      report.suites[0].warnings.length === 0,
      "Preserve reported suite status without the suite classification warning");
    check(report.suites[0].tests[1].links[0] === location.origin + "/report/example/second.htm", "Resolve literal detail links");
    var rows = ChargingReport.parseDetails(detail);
    var flowRows = ChargingReport.parseDetails(detail, location.origin + "/report/example/second.htm");
    check(flowRows[0].flowUrl === location.origin + "/report/example/scenario/930_42.htm",
      "Resolve the exact scenario flow link relative to its detail page");
    ["https://example.invalid/flow.htm", "../other/flow.htm", "./%2e%2e/flow.htm", "./scenario/file.xml",
      "javascript:alert(1)"].forEach(function (path) {
      var row = ChargingReport.parseDetails(detail.replace("./scenario/930_42.htm", path),
        location.origin + "/report/example/second.htm")[0];
      check(!row.flowUrl && !!row.flowError, "Reject unsafe scenario flow link " + path);
    });
    var missingFlow = ChargingReport.parseDetails('<div id="_TEST-FAILED-1"><p>No flow</p></div>',
      location.origin + "/report/example/second.htm")[0];
    check(!missingFlow.flowUrl && missingFlow.flowError.includes("No scenario flow"),
      "Missing scenario flow is explicit instead of falling back to the suite report");
    var twoPages = ["one", "two"].map(function (folder) {
      return ChargingReport.parseDetails(detail, location.origin + "/report/example/" + folder + "/details.htm")[0].flowUrl;
    });
    check(twoPages[0] !== twoPages[1], "Scenario links retain their own source directory across detail pages");
    check(rows[0].diagnostics.response.indexOf("AssertionError\nexpected <1>") >= 0, "Preserve response line breaks as text");
    check(rows[0].diagnostics.citFilter === "classId equals <MUSG> AND\namount equals 1", "Separate CIT filter properties from response");
    check(rows[0].diagnostics.tables[0][0].length === 8 && rows[0].diagnostics.tables[0][0][5] === "0",
      "Extract CIT table with all eight columns and zero matches");
    check(!/org\.example|Stacktrace|2 more|CIT filter/.test(rows[0].diagnostics.response) &&
      rows[0].diagnostics.response.includes("expected [true] but found [false]"),
      "Omit stack frames while preserving the assertion response");
    var plain = ChargingReport.parseDetails(detail.replace(/<div id="_STACKTRACE-1-DETAIL">[\s\S]*<\/div><\/div>$/,
      '<div id="_STACKTRACE-1-DETAIL">Simple error<br>at example.Call(file:1)</div></div>'))[0];
    check(plain.diagnostics.response === "Simple error" && !plain.diagnostics.citFilter && !plain.diagnostics.tables.length,
      "Ordinary failures remain readable without CIT sections");
    throws(function () { ChargingReport.parseDetails("<p>Incomplete</p>"); }, "Missing detail structure is an explicit error");
    throws(function () { ChargingReport.parseOverview(html + html, url); }, "Duplicate report rows are rejected");
    throws(function () { ChargingReport.parseDetails(detail + detail); }, "Duplicate scenario identifiers are rejected");
    throws(function () { ChargingReport.parseOverview("<p>Incomplete</p>", url); }, "Malformed overview is not a success");
    var malformed = ChargingReport.parseOverview(html.replace('id="btn_failed_tests">1', 'id="btn_failed_tests">?'), url);
    check(malformed.tests.failed === null && malformed.warnings.length > 1, "Missing counts stay unknown");
    [counts(4, 4, 0, 0), counts(4, 0, 4, 0), counts(4, 0, 0, 4)].forEach(function (data) {
      var chart = ChargingReport.pieChart("Outcomes", data);
      check(chart.indexOf("<circle") >= 0 && chart.indexOf("100.0%") >= 0 && chart.indexOf("NaN") < 0, "Single outcome pie covers full circle");
    });
    check(ChargingReport.pieChart("Empty", counts(0, 0, 0, 0)).indexOf("No results") >= 0, "Zero results have no fake pie");
    check(ChargingReport.pieChart("Invalid", counts(2, 2, 1, 0)).indexOf("<svg") < 0, "Contradictory totals have no pie");
    check(ChargingReport.pieChart("Missing", counts(2, null, 1, 0)).indexOf("Unknown") >= 0, "Unknown counts have text equivalent");
    ["../outside.htm", "https://example.invalid/report.htm", "javascript:alert(1)", "/C:/private.htm",
      "./%2e%2e/outside.htm", "./%252e%252e/outside.htm", "//example.invalid/report.htm", "./bad%2fpath.htm"].forEach(function (link) {
      throws(function () { ChargingReport.safeLink(link, url, new URL(".", url).href); }, "Reject unsafe link " + link);
    });
    window.__reportInjection = false;
    var payload = '<script>window.__reportInjection=true</scr' + 'ipt><img src="/unexpected-resource" onerror="window.__reportInjection=true">';
    var poisoned = ChargingReport.parseOverview(html.replace("First<div>", "&lt;img onerror=bad&gt;" + payload + "<div>"), url);
    check(!window.__reportInjection && poisoned.suites[0].tests[0].name.indexOf("<img onerror=bad>") >= 0, "Report markup remains inert data");
    await new Promise(function (resolve) { setTimeout(resolve, 40); });
    check(!performance.getEntriesByType("resource").some(function (entry) { return entry.name.indexOf("/unexpected-resource") >= 0; }),
      "Parsing report markup does not load injected resources");
    var long = ChargingReport.parseDetails(detail.replace("AssertionError", "x".repeat(41000)));
    check(long[0].diagnostics.response.indexOf("truncated") >= 0, "Oversized diagnostics explicitly truncated");

    var index = await (await fetch("../web/index.html")).text();
    frame = document.createElement("iframe");
    frame.title = "Isolated application interaction tests";
    frame.style.cssText = "width:390px;height:780px;border:1px solid #888";
    document.body.appendChild(frame);
    function bootstrap() {
      window.__requests = [];
      window.__rejectSelection = false;
      window.__reportHtml = REPORT_HTML;
      window.__detailHtml = DETAIL_HTML;
      window.__reportDelay = 0;
      window.__reportStatus = 200;
      window.__detailStatus = 200;
      window.__detailDelay = 0;
      window.__snapshotHtml = null;
      window.__activeDetails = 0;
      window.__maxActiveDetails = 0;
      var state = { selectedEnvironment: "A", environments: [
        { name: "A", properties: { host: "alpha.example.invalid" } },
        { name: "B", properties: { host: "beta.example.invalid" } },
        { name: "C", properties: { host: "gamma.example.invalid" } }
      ], targets: [{name:"example",description:"Example target",environment:"Default",suites:[]}], suites: [], reportAvailable: true };
      window.fetch = async function (input, options) {
        var path = new URL(input, document.baseURI).pathname;
        var method = options && options.method || "GET", body = {}, status = 200, type = "application/json";
        window.__requests.push({ path: path, method: method, body: options && options.body });
        if (path === "/api/state") { body = state; }
        else if (path === "/api/config/year") { body = { mode: "automatic", files: [] }; }
        else if (path === "/api/run/status") { body = {}; }
        else if (path === "/api/environment") {
          await new Promise(function (resolve) { setTimeout(resolve, 40); });
          if (window.__rejectSelection) { status = 409; body = { error: "Synthetic selection failure" }; }
          else { state.selectedEnvironment = JSON.parse(options.body).environment; }
        } else if (path === "/api/report" || path === "/report/example/Report.htm") {
          body = path !== "/api/report" && window.__snapshotHtml !== null ? window.__snapshotHtml : window.__reportHtml;
          type = "text/html"; status = window.__reportStatus;
          await new Promise(function (resolve) { setTimeout(resolve, window.__reportDelay); });
        }
        else if (path === "/report/example/second.htm" || path === "/report/example/first.htm") {
          body = path.endsWith("first.htm") ? window.__detailHtml.replace("_TEST-FAILED-1", "_TEST-PASSED-1") : window.__detailHtml;
          type = "text/html"; status = window.__detailStatus;
          window.__activeDetails++;
          window.__maxActiveDetails = Math.max(window.__maxActiveDetails, window.__activeDetails);
          await new Promise(function (resolve) { setTimeout(resolve, window.__detailDelay); });
          window.__activeDetails--;
        }
        else { throw new Error("Unexpected test API call: " + path); }
        var response = new Response(type === "text/html" ? body : JSON.stringify(body), {status:status,headers:{"Content-Type":type}});
        Object.defineProperty(response, "url", {value: location.origin + (path === "/api/report" ? "/report/example/Report.htm" : path)});
        return response;
      };
    }
    var boot = "(" + bootstrap.toString().replace("REPORT_HTML", JSON.stringify(html)).replace("DETAIL_HTML", JSON.stringify(detail)) + ")();";
    index = index.replace(/(src|href)="\/(report\.js|app\.js|styles\.css)([^"]*)"/g, '$1="' + location.origin + '/app/web/$2$3"');
    frameUrl = URL.createObjectURL(new Blob([index.replace("<head>", '<head><base href="' +
      location.origin + '/app/web/index.html"><script>' + boot + "</scr" + "ipt>")], {type:"text/html"}));
    frame.src = frameUrl;
    var w = frame.contentWindow;
    await until(function () { return frame.contentDocument.querySelectorAll('[role="option"]').length === 3; }, "Picker did not initialize");
    var d = frame.contentDocument;
    function key(target, name) { target.dispatchEvent(new w.KeyboardEvent("keydown", { key: name, bubbles: true })); }
    function posts() { return w.__requests.filter(function (r) { return r.method === "POST"; }); }
    var trigger = d.getElementById("environment-select"), options = d.getElementById("environment-options");
    trigger.click();
    check(trigger.getAttribute("aria-expanded") === "true" && d.activeElement === options, "Picker opens with listbox focus");
    key(options, "ArrowDown");
    check(d.getElementById("environment-detail").textContent.indexOf("beta.example.invalid") >= 0 && posts().length === 0, "Keyboard preview never persists");
    var third = d.querySelector('[data-environment-index="2"]');
    third.dispatchEvent(new w.PointerEvent("pointerover", {bubbles:true,pointerType:"mouse"}));
    check(d.getElementById("environment-detail").textContent.indexOf("gamma.example.invalid") >= 0 && posts().length === 0, "Hover preview never persists");
    key(options, "Escape");
    check(d.getElementById("environment-popup").hidden && d.activeElement === trigger, "Escape closes and restores focus");
    trigger.click();
    check(!d.getElementById("environment-show-details") &&
      d.getElementById("environment-detail").getBoundingClientRect().height > 0 && posts().length === 0,
      "Picker exposes details without a separate Details button or a selection");
    d.getElementById("environment-preview-next").click();
    check(d.getElementById("environment-detail").textContent.indexOf("beta.example.invalid") >= 0 && posts().length === 0,
      "Touch preview navigation inspects another environment without selection");
    key(d.activeElement, "Escape");
    trigger.click(); key(options, "End"); key(options, "Enter"); key(options, "Enter");
    await until(function () { return !trigger.disabled; }, "Selection did not settle");
    check(posts().length === 1 && JSON.parse(posts()[0].body).environment === "C", "Explicit selection persists once");
    check(d.getElementById("environment-selected-name").textContent === "C", "Successful selection updates current environment");
    w.__rejectSelection = true;
    trigger.click(); key(options, "Home"); key(options, "Enter");
    await until(function () { return !trigger.disabled; }, "Rejected selection did not settle");
    check(d.getElementById("environment-selected-name").textContent === "C" && d.getElementById("message").textContent.indexOf("Synthetic selection failure") >= 0,
      "Rejected selection retains previous state and shows error");
    key(options, "b");
    check(options.getAttribute("aria-activedescendant") === "environment-option-1", "Type-ahead previews matching option");
    check(!d.getElementById("environment-list"), "Separate homepage environment list removed");
    check(d.querySelector(".target-environment").tagName === "SELECT", "Target-specific native picker retained");
    d.body.dispatchEvent(new w.PointerEvent("pointerdown", {bubbles:true}));
    check(d.getElementById("environment-popup").hidden, "Outside pointer dismisses picker");
    w.__detailHtml = detail +
      '<div id="_TEST-PASSED-2"><p>Passed scenario</p><button id="log_btn_2" onclick="window.open(\'./scenario/930_43.htm\')">Log</button></div>' +
      '<div id="_TEST-SKIPPED-3"><p>Skipped scenario</p><button id="log_btn_3" onclick="window.open(\'./scenario/930_44.htm\')">Log</button></div>';
    d.getElementById("open-report").click();
    await until(function () { return d.querySelectorAll(".report-chart svg").length === 2; }, "Report screen did not load");
    await until(function () { return !!d.querySelector(".report-failure-scenario"); }, "Automatic failure summary did not load");
    var failureSummary = d.getElementById("report-failures"), summaryContent = failureSummary.textContent;
    var flowLink = failureSummary.querySelector(".report-failure-scenario a");
    check(flowLink && flowLink.href === location.origin + "/report/example/scenario/930_42.htm" &&
      flowLink.textContent === "Open scenario flow report" && flowLink.target === "_blank" &&
      !failureSummary.querySelector('a[href$="/second.htm"]'),
      "Summary links directly from the failed scenario to its flow report, not the test report");
    var summaryToggle = failureSummary.querySelector("summary");
    check(failureSummary.tagName === "DETAILS" && !failureSummary.open &&
      summaryToggle.textContent === "Summary" &&
      d.getElementById("report-summary").nextElementSibling === failureSummary,
      "Summary is collapsed below the report charts with the requested title");
    summaryToggle.click();
    check(failureSummary.open && parseFloat(w.getComputedStyle(summaryToggle.querySelector("h2")).fontSize) >= 28,
      "Clicking the prominent Summary title expands the summary");
    summaryToggle.click();
    check(!failureSummary.open, "Clicking Summary again collapses it");
    check(summaryContent.includes("Second") && summaryContent.includes("Suite & example") &&
      summaryContent.includes("param set id: 42") && summaryContent.includes("Charged item validation failed: expected 1 CIT(s), but found 0."),
      "Automatic summary groups the failed test, suite, scenario and recorded validation reason");
    check(d.querySelectorAll(".report-failure-differences li").length === 4 &&
      summaryContent.includes("Expected: 0.001269") && summaryContent.includes("123: [0.001074]") &&
      !failureSummary.querySelector("img,script") && !summaryContent.includes("org.example"),
      "Summary shows actual CIT differences without matching rows, injected markup or stack frames");
    check(w.__requests.filter(function (r) { return r.path === "/report/example/second.htm"; }).length === 1 &&
      !w.__requests.some(function (r) { return r.path === "/report/example/first.htm"; }),
      "Summary automatically reads failed tests only");
    check(d.title === "Test report · Automated Testing Tool" && d.getElementById("home-screen").hidden, "Report opens within application route");
    var filter = d.getElementById("report-filter");
    var scenarioFilter = d.getElementById("report-scenario-filter");
    function chooseStatuses(group, statuses) {
      group.querySelector('[data-status="all"]').click();
      if (statuses.length < 3) {
        statuses.forEach(function (status) { group.querySelector('[data-status="' + status + '"]').click(); });
      }
    }
    var combinations = [["passed"], ["failed"], ["skipped"], ["passed", "failed"],
      ["passed", "skipped"], ["failed", "skipped"], ["passed", "failed", "skipped"]];
    check(!filter.querySelector("select") && !scenarioFilter.querySelector("select") &&
      d.querySelectorAll('.report-status-filter button[aria-pressed="true"]').length === 2 &&
      filter.querySelector('[data-status="all"]').getAttribute("aria-pressed") === "true" &&
      scenarioFilter.querySelector('[data-status="all"]').getAttribute("aria-pressed") === "true",
      "Both outcome groups default to All");
    filter.querySelector('[data-status="failed"]').click();
    check(d.querySelectorAll(".report-test").length === 1 &&
      d.querySelector(".report-test .report-status--failed"), "One click on Failed isolates failed tests from All");
    filter.querySelector('[data-status="skipped"]').click();
    check(filter.querySelector('[data-status="failed"]').getAttribute("aria-pressed") === "true" &&
      filter.querySelector('[data-status="skipped"]').getAttribute("aria-pressed") === "true" &&
      filter.querySelector('[data-status="all"]').getAttribute("aria-pressed") === "false",
      "A second status click adds to the test selection");
    combinations.forEach(function (statuses) {
      chooseStatuses(filter, statuses);
      var shown = Array.from(d.querySelectorAll(".report-test > summary .report-status")).map(function (badge) {
        return badge.textContent.toLowerCase();
      });
      check(shown.join("|") === ["passed", "failed"].filter(function (status) { return statuses.indexOf(status) >= 0; }).join("|"),
        "Test buttons combine " + statuses.join(" and ") + " outcomes");
    });
    chooseStatuses(filter, ["failed"]);
    filter.querySelector('[data-status="failed"]').click();
    check(filter.querySelector('[data-status="all"]').getAttribute("aria-pressed") === "true" &&
      d.querySelectorAll(".report-test").length === 2, "Deselecting the last test status restores All");
    filter.querySelector('[data-status="failed"]').click();
    check(d.querySelectorAll(".report-test").length === 1 && d.querySelector(".report-chart__total").textContent.indexOf("2") >= 0, "Filtering leaves charts report-wide");
    var beforeExpansion = w.__requests.length;
    chooseStatuses(scenarioFilter, ["failed"]);
    d.querySelector(".report-test summary").click();
    await until(function () { return !!d.querySelector(".report-diagnostic"); }, "Failure details did not load");
    check(d.querySelectorAll(".report-scenario:not([hidden])").length === 1 &&
      d.querySelector(".report-scenario:not([hidden])").dataset.scenarioStatus === "failed",
      "Lazy details respect the selected scenario status buttons");
    check(d.querySelector(".report-scenarios").textContent.indexOf("AssertionError") >= 0 &&
      w.__requests.length === beforeExpansion, "Expanded failed test reuses automatic summary data");
    var diagnosticSections = Array.from(d.querySelectorAll(".report-diagnostic-section"));
    check(diagnosticSections.length === 3 && diagnosticSections.every(function (section) { return !section.open; }) &&
      diagnosticSections.map(function (section) { return section.querySelector("summary").textContent; }).join("|") ===
        "Description|Response Details|CIT filter", "Description, response and CIT filter are separate collapsed disclosures");
    diagnosticSections[0].querySelector("summary").click();
    check(diagnosticSections[0].open && !diagnosticSections[1].open, "Description opens independently");
    diagnosticSections[0].querySelector("summary").click();
    check(Array.from(d.querySelectorAll(".report-cit-table th")).map(function (cell) { return cell.textContent; }).join("|") ===
      "CIT filter|Field|Rule|Expected Value|Operation|Number of matched CIT(s)|Matched CIT ID list|Values in CIT(s)",
      "CIT table renders the requested column headings");
    check(d.querySelector(".report-cit-table td:last-child").textContent === "<img src=x onerror=alert(1)>" &&
      !d.querySelector(".report-cit-table img") && !d.querySelector(".report-scenarios").textContent.includes("org.example"),
      "Table values are escaped and Java stack frames are absent");
    var scenarioLinks = Array.from(d.querySelectorAll(".report-scenario .report-scenario-link a"));
    check(scenarioLinks.length === 3 && scenarioLinks.every(function (link, index) {
      return link.href === location.origin + "/report/example/scenario/930_" + (42 + index) + ".htm" &&
        link.target === "_blank" && link.rel.includes("noopener");
    }), "Each scenario outcome has its own safe flow report link");
    check(diagnosticSections[1].nextElementSibling.classList.contains("report-scenario-link") &&
      diagnosticSections[1].nextElementSibling.nextElementSibling === diagnosticSections[2],
      "Scenario flow link sits below Response Details and above CIT filter");
    check(!d.querySelector("#report-results script"), "Report data does not introduce scripts");
    var citRows = d.querySelectorAll(".report-cit-table tbody tr");
    citComparisons.forEach(function (item, index) {
      var row = citRows[index + 1], highlighted = row.classList.contains("report-cit-mismatch");
      check(highlighted === item.mismatch &&
        (w.getComputedStyle(row).backgroundColor === "rgb(255, 229, 226)") === item.mismatch,
        "CIT row highlighting handles " + item.label);
    });
    var requestsBeforeFilter = w.__requests.length;
    combinations.forEach(function (statuses) {
      chooseStatuses(scenarioFilter, statuses);
      var shown = Array.from(d.querySelectorAll(".report-scenario")).filter(function (row) { return !row.hidden; });
      check(shown.length === statuses.length &&
        shown.every(function (row) { return statuses.indexOf(row.getAttribute("data-scenario-status")) >= 0; }),
        "Scenario buttons combine " + statuses.join(" and ") + " outcomes");
    });
    check(w.__requests.length === requestsBeforeFilter && d.querySelector(".report-chart__total").textContent.indexOf("2") >= 0,
      "Scenario filtering neither refetches nor changes report-wide charts");
    scenarioFilter.querySelector('[data-status="all"]').click();
    check(d.querySelectorAll(".report-scenario:not([hidden])").length === 3, "All restores every scenario");
    scenarioFilter.querySelector('[data-status="failed"]').click();
    check(d.querySelectorAll(".report-scenario:not([hidden])").length === 1 &&
      d.querySelector(".report-scenario:not([hidden])").dataset.scenarioStatus === "failed",
      "One click on Failed isolates failed scenarios from All");
    scenarioFilter.querySelector('[data-status="skipped"]').click();
    check(d.querySelectorAll(".report-scenario:not([hidden])").length === 2 &&
      d.querySelector('.report-scenario[data-scenario-status="passed"]').hidden,
      "Clicking Failed then Skipped shows both scenario outcomes");
    check(failureSummary.textContent === summaryContent, "Summary remains unchanged by test and scenario status filters");
    chooseStatuses(scenarioFilter, ["skipped"]);
    scenarioFilter.querySelector('[data-status="skipped"]').click();
    check(scenarioFilter.querySelector('[data-status="all"]').getAttribute("aria-pressed") === "true" &&
      d.querySelectorAll(".report-scenario:not([hidden])").length === 3,
      "Deselecting the last scenario status restores All");
    scenarioFilter.querySelector('[data-status="skipped"]').click();
    check(filter.querySelectorAll('[aria-pressed="true"]').length === 1 &&
      filter.querySelector('[data-status="failed"]').getAttribute("aria-pressed") === "true",
      "Test and scenario status choices are independent");
    var expandedTest = d.querySelector(".report-test");
    expandedTest.open = false;
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    expandedTest.open = true;
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    check(d.querySelectorAll(".report-scenario:not([hidden])").length === 1 &&
      d.querySelector(".report-scenario:not([hidden])").getAttribute("data-scenario-status") === "skipped",
      "Cached details retain the selected scenario filter");
    w.__detailHtml = detail;
    chooseStatuses(filter, ["passed", "failed", "skipped"]);
    w.__reportHtml += "\n";
    d.querySelector(".report-test summary").click();
    await until(function () { return !!d.querySelector(".report-scenarios .inline-error"); }, "Changed report was not detected");
    check(d.querySelector(".report-scenarios .inline-error").textContent.indexOf("Report changed") >= 0,
      "Changed overview cannot be combined with stale detail snapshot");
    w.__reportHtml = html;
    w.__detailHtml = "<p>Incomplete detail</p>";
    d.querySelector(".report-scenarios button").click();
    await until(function () { return !!d.querySelector(".report-scenarios .inline-error"); }, "Incomplete detail did not fail");
    check(d.querySelector(".report-scenarios").textContent.indexOf("No supported scenario") >= 0,
      "Malformed detail produces retryable error");
    w.__detailHtml = detail;
    d.querySelector(".report-scenarios button").click();
    await until(function () { return !!d.querySelector(".report-test .report-scenario"); }, "Detail retry failed");
    check(!d.querySelector(".report-test .inline-error"), "Detail retry recovers without leaving report screen");
    check(d.querySelector(".report-scenario-count").textContent.indexOf("No scenarios match") >= 0 &&
      d.querySelectorAll(".report-test:first-of-type .report-scenario:not([hidden])").length === 0,
      "Scenario filter shows an explicit no-match message");
    [390,1280].forEach(function (width) {
      frame.style.width = width + "px";
      check(d.documentElement.scrollWidth <= w.innerWidth, width + "px report has no horizontal page overflow");
    });
    d.getElementById("report-back").click();
    await until(function () { return !d.getElementById("home-screen").hidden; }, "Back navigation failed");
    trigger.click();
    frame.style.width = "390px";
    check(d.documentElement.scrollWidth <= w.innerWidth, "390px picker and details fit viewport");
    [390,1280].forEach(function (width) {
      frame.style.width = width + "px";
      var heading = d.getElementById("environment-heading").getBoundingClientRect();
      var picker = d.getElementById("environment-picker").getBoundingClientRect();
      var popup = d.getElementById("environment-popup").getBoundingClientRect();
      check(picker.top >= heading.bottom && Math.abs(picker.left - heading.left) < 1,
        width + "px environment choice is below and aligned with its title");
      check(popup.top >= trigger.getBoundingClientRect().bottom &&
        d.getElementById("suites-heading").getBoundingClientRect().top >= popup.bottom,
        width + "px details expand below the choice without covering targets");
    });
    w.__reportDelay = 150;
    d.getElementById("open-report").click();
    await until(function () { return d.getElementById("report-refresh").disabled; }, "Delayed load did not start");
    d.getElementById("report-back").click();
    await new Promise(function (resolve) { setTimeout(resolve, 200); });
    check(d.getElementById("report-screen").hidden && !d.querySelector("#report-summary .report-chart"),
      "Late report response is discarded after navigation");
    w.__reportDelay = 0; w.__reportStatus = 404;
    d.getElementById("open-report").click();
    await until(function () { return d.getElementById("report-message").className === "inline-error"; }, "Missing report did not fail");
    check(d.getElementById("report-message").textContent.indexOf("No report") >= 0, "Missing report has explicit empty/error message");
    w.__reportStatus = 200;
    d.getElementById("report-refresh").click();
    await until(function () { return d.querySelectorAll(".report-chart svg").length === 2; }, "Report refresh did not recover");
    check(!d.getElementById("report-refresh").disabled, "Refresh recovers after missing report");
    await until(function () { return !!d.querySelector(".report-failure-scenario"); }, "Summary did not recover after missing report");
    async function refreshSummary() {
      d.getElementById("report-refresh").click();
      await until(function () {
        return !d.getElementById("report-refresh").disabled && failureSummary.textContent &&
          !/Loading failure reasons|Waiting for failure details/.test(failureSummary.textContent);
      }, "Failure summary did not settle");
    }
    summaryContent = failureSummary.textContent;
    var beforeSearch = w.__requests.length, search = d.getElementById("report-search");
    search.value = "does-not-exist"; search.dispatchEvent(new w.Event("input"));
    check(!d.querySelector(".report-test") && failureSummary.textContent === summaryContent &&
      w.__requests.length === beforeSearch, "Search cannot hide or reload the report-wide failure summary");
    search.value = ""; search.dispatchEvent(new w.Event("input"));

    w.__detailHtml = detail + '<div id="_TEST-FAILED-4"><p>Second failed scenario</p>' +
      '<div id="_STACKTRACE-4-DETAIL">Network timeout &lt;unsafe&gt;<br>at example.Call(file:1)</div></div>' +
      '<div id="_TEST-FAILED-5"><p>Failure without diagnostics</p></div>';
    await refreshSummary();
    check(d.querySelectorAll(".report-failure-scenario").length === 3 &&
      failureSummary.textContent.includes("Network timeout <unsafe>") &&
      failureSummary.textContent.includes("The report provides no failure reason") &&
      !failureSummary.textContent.includes("at example.Call") && !failureSummary.querySelector("unsafe"),
      "Multiple failed scenarios retain plain error fallbacks and explicit missing reasons");
    w.__detailHtml = '<div id="_TEST-PASSED-1"><p>Passing detail only</p></div>';
    await refreshSummary();
    check(failureSummary.textContent.includes("no failed scenario details were recorded") &&
      !failureSummary.textContent.includes("No failed tests"), "Failed tests without failed detail rows are not presented as success");

    w.__detailHtml = detail; w.__detailStatus = 404;
    await refreshSummary();
    check(failureSummary.textContent.includes("Failure reason unavailable") && !!failureSummary.querySelector("button"),
      "Missing failure file has an explicit error and retry");
    w.__detailStatus = 200;
    failureSummary.querySelector("button").click();
    await until(function () { return !!failureSummary.querySelector(".report-failure-scenario"); }, "Summary retry did not recover");
    check(!failureSummary.querySelector(".inline-error"), "Summary retry recovers without refreshing the overview");

    w.__detailHtml = "<p>Malformed detail</p>";
    await refreshSummary();
    check(failureSummary.textContent.includes("No supported scenario"), "Malformed failure detail remains an explicit summary error");
    w.__detailHtml = detail;
    w.__snapshotHtml = html + "\nchanged";
    await refreshSummary();
    check(failureSummary.textContent.includes("Report changed"), "Automatic summary rejects changed report snapshots");
    w.__snapshotHtml = null;

    w.__reportHtml = html.replace(/<button onclick="window.open\('\.\/second.htm'\)">Detail<\/button>/, "");
    await refreshSummary();
    check(failureSummary.textContent.includes("Details are unavailable"), "Failed test without a safe link remains visible with an unavailable reason");
    var allPassed = html.replace(/_TEST-FAILED/g, "_TEST-PASSED")
      .replace("<td>0</td><td>1</td><td>0</td>", "<td>1</td><td>0</td><td>0</td>")
      .replace(/(btn_passed_(?:tests|scenarios)">)1/g, function (_, prefix) { return prefix + "2"; })
      .replace(/(btn_failed_(?:tests|scenarios)">)1/g, function (_, prefix) { return prefix + "0"; });
    w.__reportHtml = allPassed;
    var readsBeforePass = w.__requests.filter(function (r) { return /\/(?:first|second)\.htm$/.test(r.path); }).length;
    await refreshSummary();
    check(failureSummary.textContent.includes("No failed tests or scenarios were reported") &&
      w.__requests.filter(function (r) { return /\/(?:first|second)\.htm$/.test(r.path); }).length === readsBeforePass,
      "Consistent all-pass report has an explicit empty summary and no automatic detail reads");
    w.__reportHtml = allPassed.replace('id="btn_failed_tests">0', 'id="btn_failed_tests">?');
    await refreshSummary();
    check(failureSummary.textContent.includes("could not be identified reliably") &&
      !failureSummary.textContent.includes("No failed tests"), "Unknown totals never become a no-failures claim");
    w.__reportHtml = html.replace(/_TEST-FAILED/g, "_TEST-PASSED")
      .replace('id="btn_passed_tests">1', 'id="btn_passed_tests">2')
      .replace('id="btn_failed_tests">1', 'id="btn_failed_tests">0');
    await refreshSummary();
    check(!!failureSummary.querySelector(".report-failure-scenario") &&
      failureSummary.querySelector(".report-status--passed"), "Failed scenario totals are included without rewriting reported test status");

    w.__reportHtml = html;
    w.__detailDelay = 150;
    d.getElementById("report-refresh").click();
    await until(function () { return w.__activeDetails > 0 && !!d.querySelector(".report-test"); }, "Delayed detail did not start");
    var readsWhilePending = w.__requests.filter(function (r) { return r.path === "/report/example/second.htm"; }).length;
    d.querySelector('[data-report-test="_TEST-FAILED-2-SUITE-1"]').open = true;
    await until(function () { return !!failureSummary.querySelector(".report-failure-scenario") &&
      !!d.querySelector(".report-scenario"); }, "Shared pending detail did not resolve");
    check(w.__requests.filter(function (r) { return r.path === "/report/example/second.htm"; }).length === readsWhilePending,
      "Expansion and automatic summary deduplicate in-flight detail requests");

    d.getElementById("report-refresh").click();
    await until(function () { return w.__activeDetails > 0; }, "Stale detail fixture did not start");
    w.__detailDelay = 0; w.__detailHtml = '<div id="_TEST-FAILED-1"><p>New report scenario</p>' +
      '<div id="_STACKTRACE-1-DETAIL">New failure reason</div></div>';
    await refreshSummary();
    await new Promise(function (resolve) { setTimeout(resolve, 200); });
    check(failureSummary.textContent.includes("New failure reason") && !failureSummary.textContent.includes("Charged item validation failed"),
      "Refresh discards late details from the previous summary");
    w.__detailDelay = 150;
    d.getElementById("report-refresh").click();
    await until(function () { return w.__activeDetails > 0; }, "Navigation race detail did not start");
    d.getElementById("report-back").click();
    await new Promise(function (resolve) { setTimeout(resolve, 200); });
    check(d.getElementById("report-screen").hidden && !failureSummary.querySelector(".report-failure-scenario"),
      "Leaving the report discards late failure-summary updates");

    var extra = "";
    [3, 4, 5].forEach(function (id) {
      extra += '<tr id="_TEST-FAILED-' + id + '-SUITE-1"><td><a>Extra ' + id +
        '</a></td><td>0</td><td>1</td><td>0</td></tr><tr id="_TEST-FAILED-' + id +
        '-SUITE-1-LINK-L1-1"><td><button onclick="window.open(\'./second.htm\')">Detail</button></td></tr>';
    });
    w.__reportHtml = html.replace("</table></div>", extra + "</table></div>");
    w.__detailDelay = 50; w.__detailHtml = detail; w.__maxActiveDetails = 0;
    d.getElementById("open-report").click();
    await until(function () { return failureSummary.querySelectorAll(".report-failure-scenario").length === 4; },
      "Queued failure summaries did not finish");
    check(w.__maxActiveDetails <= 2 && w.__maxActiveDetails > 0, "Automatic failure loading is bounded to two concurrent detail reads");
    failureSummary.querySelector("summary").click();
    [390, 1280].forEach(function (width) {
      frame.style.width = width + "px";
      check(d.documentElement.scrollWidth <= w.innerWidth, width + "px populated failure summary fits the viewport");
    });
    check(posts().length === 2, "Report reads and browsing introduce no mutations");
  } catch (error) { failures.push(error.stack || String(error)); }
  finally {
    if (frame) { frame.remove(); }
    if (frameUrl) { URL.revokeObjectURL(frameUrl); }
    window.reportTests = { passed: passed, failures: failures };
    document.getElementById("test-results").textContent = passed.map(function (s) { return "PASS " + s; }).join("\n") +
      "\n\n" + (failures.length ? "FAIL\n" + failures.join("\n") : "All " + passed.length + " checks passed.");
  }
  function counts(total, passedCount, failedCount, skippedCount) {
    return {total:total,passed:passedCount,failed:failedCount,skipped:skippedCount};
  }
}());
