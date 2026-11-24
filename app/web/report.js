(function () {
  "use strict";

  var outcomes = ["passed", "failed", "skipped"];
  var maxBytes = 8 * 1024 * 1024;
  var maxItems = 5000;
  var maxDiagnostic = 40000;

  function escape(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function documentFor(html) {
    if (html.length > maxBytes) { throw new Error("Report exceeds the 8 MiB display limit. Open the original report."); }
    var template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  }

  function text(node) {
    if (!node) { return ""; }
    var copy = node.cloneNode(true);
    copy.querySelectorAll("script,style,iframe,object,template").forEach(function (item) { item.remove(); });
    copy.querySelectorAll("br").forEach(function (item) { item.replaceWith("\n"); });
    copy.querySelectorAll("p,div,tr,li").forEach(function (item) { item.appendChild(document.createTextNode("\n")); });
    copy.querySelectorAll("td,th").forEach(function (item) { item.appendChild(document.createTextNode("\t")); });
    return copy.textContent.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  }

  function compact(node) { return text(node).replace(/\s+/g, " "); }
  function count(value) {
    var number = /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(number) ? number : null;
  }
  function counts(total, passed, failed, skipped) {
    return { total: total, passed: passed, failed: failed, skipped: skipped };
  }
  function validCounts(values) {
    return ["total"].concat(outcomes).every(function (key) { return values[key] !== null; }) &&
      values.total === values.passed + values.failed + values.skipped;
  }
  function outcomeCounts(items) {
    var result = counts(items.length, 0, 0, 0);
    items.forEach(function (item) { result[item.status]++; });
    return result;
  }
  function sameCounts(a, b) {
    return ["total"].concat(outcomes).every(function (key) { return a[key] === b[key]; });
  }
  function pathParts(path) {
    return path.split("/").map(function (part) {
      var decoded = decodeURIComponent(part);
      if (decoded === "." || decoded === ".." || /[\\/%\u0000-\u001f]/.test(decoded)) {
        throw new Error("Unsafe report path.");
      }
      return decoded;
    });
  }
  function safeLink(value, base, root) {
    if (!value || /[\\\u0000-\u0020]/.test(value) || /%(?:2e|2f|5c|25)/i.test(value) ||
        value.split("/").some(function (p) { return p === ".."; })) {
      throw new Error("Unsupported report link.");
    }
    var url = new URL(value, base);
    var boundary = new URL(root);
    var parts = pathParts(url.pathname), rootParts = pathParts(boundary.pathname);
    if (url.origin !== window.location.origin || url.origin !== boundary.origin ||
        url.username || url.password || url.search || url.hash ||
        parts[1] !== "report" || !/\.html?$/i.test(url.pathname) ||
        !rootParts.every(function (part, i) { return !part || parts[i] === part; })) {
      throw new Error("Report link is outside the selected report directory.");
    }
    return url.href;
  }
  function sourceUrl(value) {
    var url = new URL(value, window.location.href);
    pathParts(url.pathname);
    if (url.origin !== window.location.origin || !/^\/report\/(?:.*\/)?Report\.htm$/i.test(url.pathname) ||
        url.search || url.hash) { throw new Error("Unexpected report source URL."); }
    return url.href;
  }
  function duration(node) {
    var match = compact(node).match(/(?:^|\s)(\d+(?:\.\d+)?)\s*s(?:\s|$)/);
    return match ? match[1] + " s" : "Not reported";
  }
  function shortName(node) {
    if (!node) { return "Unnamed test"; }
    var copy = node.cloneNode(true);
    copy.querySelectorAll("div,button").forEach(function (item) { item.remove(); });
    return compact(copy).replace(/^\d+\s+/, "") || "Unnamed test";
  }

  function parseOverview(html, url) {
    url = sourceUrl(url);
    var root = new URL(".", url).href, dom = documentFor(html), warnings = [];
    function summary(kind) {
      return counts.apply(null, ["all"].concat(outcomes).map(function (status) {
        return count(compact(dom.querySelector("#btn_" + status + "_" + kind)));
      }));
    }
    var model = { url: url, root: root, suites: [], tests: summary("tests"), scenarios: summary("scenarios"),
      suiteCounts: summary("suites"), warnings: warnings };
    if (!dom.querySelector("#btn_all_tests")) { throw new Error("Unrecognized or incomplete report format. Open the original report."); }
    var metadata = Array.from(dom.querySelectorAll("p")).find(function (p) { return /Report created at:/.test(p.textContent); });
    var meta = compact(metadata), created = meta.match(/Report created at:\s*([^|]+?)(?:\s*\||$)/);
    model.created = created ? created[1].trim() : "Not reported";
    model.duration = duration(metadata);
    var suites = Array.from(dom.querySelectorAll("div[id]")).filter(function (node) {
      return /^_SUITE-(PASSED|FAILED|SKIPPED)-\d+$/.test(node.id);
    });
    if (suites.length > maxItems) { throw new Error("Too many suites to display. Open the original report."); }
    var seen = {}, allTests = [];
    suites.forEach(function (node) {
      if (seen[node.id]) { throw new Error("Duplicate suite identifiers in report."); }
      seen[node.id] = true;
      var status = node.id.match(/^_SUITE-(\w+)-/)[1].toLowerCase();
      var suite = { id: node.id, name: shortName(node.querySelector("th")), status: status,
        duration: duration(node.querySelectorAll("tr")[1]), tests: [], warnings: [] };
      Array.from(node.querySelectorAll("tr[id]")).forEach(function (row) {
        var match = row.id.match(/^_TEST-(PASSED|FAILED|SKIPPED)-\d+-SUITE-\d+$/);
        if (!match) { return; }
        if (seen[row.id]) { throw new Error("Duplicate test identifiers in report."); }
        seen[row.id] = true;
        var cells = Array.from(row.children).filter(function (cell) { return cell.tagName === "TD"; });
        var values = cells.slice(1, 4).map(function (cell) { return count(compact(cell)); });
        while (values.length < 3) { values.push(null); }
        var total = values.every(function (value) { return value !== null; }) ? values[0] + values[1] + values[2] : null;
        var test = { id: row.id, name: shortName(row.querySelector("a") || cells[0]),
          status: match[1].toLowerCase(), duration: duration(cells[0]),
          counts: counts(total, values[0], values[1], values[2]), links: [], warnings: [] };
        var sibling = row.nextElementSibling;
        while (sibling && sibling.id.indexOf(row.id + "-LINK-L1-") === 0) {
          sibling.querySelectorAll("button[onclick]").forEach(function (button) {
            var call = button.getAttribute("onclick").match(/^\s*window\.open\(\s*(['"])([^'"]+)\1\s*\)\s*;?\s*$/);
            try {
              if (!call) { throw new Error("Unsupported diagnostic link format."); }
              var link = safeLink(call[2], url, root);
              if (test.links.indexOf(link) < 0) { test.links.push(link); }
            } catch (error) { test.warnings.push(error.message); }
          });
          sibling = sibling.nextElementSibling;
        }
        if (!validCounts(test.counts)) { test.warnings.push("Scenario totals are missing or invalid."); }
        if (test.status === "passed" && test.counts.failed > 0) {
          test.warnings.push("Report marks this test passed, but includes failed scenarios.");
        }
        if (!test.links.length) { test.warnings.push("No supported detailed report link is available."); }
        suite.tests.push(test);
        allTests.push(test);
      });
      model.suites.push(suite);
    });
    if (allTests.length > maxItems) { throw new Error("Too many tests to display. Open the original report."); }
    ["tests", "scenarios", "suiteCounts"].forEach(function (key) {
      if (!validCounts(model[key])) { warnings.push("Reported " + key.replace("Counts", "") + " totals are missing or inconsistent; no pie is calculated for them."); }
    });
    if (!sameCounts(outcomeCounts(allTests), model.tests)) {
      warnings.push("Test rows do not match the overview totals. The report may be incomplete.");
    }
    if (!sameCounts(outcomeCounts(model.suites), model.suiteCounts)) {
      warnings.push("Suite rows do not match the overview totals.");
    }
    var aggregate = counts(0, 0, 0, 0);
    allTests.forEach(function (test) {
      Object.keys(aggregate).forEach(function (key) {
        aggregate[key] = aggregate[key] === null || test.counts[key] === null ? null : aggregate[key] + test.counts[key];
      });
    });
    if (!sameCounts(aggregate, model.scenarios)) { warnings.push("Scenario counts in test rows do not match the overview totals."); }
    var reliableSuiteCounts = validCounts(model.suiteCounts) &&
      sameCounts(outcomeCounts(model.suites), model.suiteCounts);
    model.suites.forEach(function (suite) {
      if (suite.tests.some(function (test) { return test.status === "failed"; })) { suite.status = "failed"; }
      else if (suite.tests.length) {
        suite.status = suite.tests.every(function (test) { return test.status === "skipped"; }) ? "skipped" : "passed";
      }
    });
    model.suiteCounts = reliableSuiteCounts ? outcomeCounts(model.suites) : counts(null, null, null, null);
    return model;
  }

  function orderSuites(model, targets) {
    function name(value) { return value.replace(/\s+/g, " ").trim(); }
    var names = model.suites.map(function (suite) { return name(suite.name); });
    if (new Set(names).size !== names.length) { throw new Error("Duplicate suite names prevent an unambiguous match to test.xml."); }
    var candidates = targets.map(function (target) {
      var matching = target.suites.map(function (suite) { return name(suite.name); }).filter(function (value) {
        return names.indexOf(value) >= 0;
      });
      return { target: target.target, names: matching };
    }).filter(function (target) {
      return target.names.length === names.length && new Set(target.names).size === names.length;
    });
    if (!names.length) { return "No executed suites to order."; }
    if (!candidates.length) { throw new Error("No target in test.xml uniquely matches all reported suite names."); }
    var order = candidates[0].names;
    if (candidates.some(function (target) { return JSON.stringify(target.names) !== JSON.stringify(order); })) {
      throw new Error("Matching targets in test.xml specify different suite orders.");
    }
    model.suites.sort(function (a, b) { return order.indexOf(name(a.name)) - order.indexOf(name(b.name)); });
    return "Suite display follows the current test.xml include order (" +
      candidates.map(function (target) { return target.target; }).join(", ") + ").";
  }

  function diagnostic(node) {
    var value = text(node);
    return boundedDiagnostic(value);
  }
  function boundedDiagnostic(value) {
    return value.length > maxDiagnostic ? value.slice(0, maxDiagnostic) +
      "\n[Diagnostic truncated at 40,000 characters. Open the original report for the full output.]" : value;
  }
  var citColumns = ["CIT filter", "Field", "Rule", "Expected Value", "Operation",
    "Number of matched CIT(s)", "Matched CIT ID list", "Values in CIT(s)"];

  function citValueMismatch(cells) {
    var values = cells[7].match(/\[[^\[\]]*\]/g) || [];
    return values.some(function (value) {
      return value.slice(1, -1).trim() !== cells[3].trim();
    });
  }

  function summaryText(value, limit) {
    return value.length > limit ? value.slice(0, limit) + " [shortened; see full scenario details]" : value;
  }
  function failureReason(row) {
    var response = row.diagnostics.response;
    var countMatch = response.match(/expected number of CIT\(s\):\s*(\d+),?\s*but found:\s*(\d+)/i);
    if (/Validation failed/i.test(response) && countMatch) {
      var item = response.match(/validation item:\s*([^\n;]+)/i);
      return (item ? summaryText(item[1].trim(), 160) : "Charged item validation") +
        " failed: expected " + countMatch[1] + " CIT(s), but found " + countMatch[2] + ".";
    }
    return response ? summaryText(response, 600) : "The report provides no failure reason for this scenario.";
  }
  function failureScenarios(data) {
    var failed = data.rows.filter(function (row) { return row.status === "failed"; });
    return warningsHtml(data.warnings) + (failed.length ? failed.slice(0, 50).map(function (row) {
      var differences = row.diagnostics.tables.flatMap(function (table) { return table.filter(citValueMismatch); });
      return '<section class="report-failure-scenario"><h4>' + escape(row.name) +
        '</h4><p class="report-failure-reason">' + escape(failureReason(row)) + "</p>" +
        warningsHtml(row.diagnostics.warnings) +
        (differences.length ? '<p class="field-help">Recorded CIT value differences (not an inferred root cause):</p>' +
          '<ul class="report-failure-differences">' + differences.slice(0, 20).map(function (cells) {
            return "<li><strong>" + escape(cells[1]) + "</strong> (filter " + escape(cells[0]) +
              ", rule: " + escape(cells[2]) + ")<br>Expected: <code>" +
              escape(summaryText(cells[3], 500) || "(empty)") + "</code><br>Actual CIT values: <code>" +
              escape(summaryText(cells[7], 500)) + "</code></li>";
          }).join("") + "</ul>" +
          (differences.length > 20 ? '<p class="field-help">Showing 20 of ' + differences.length +
            " differing rows. See full scenario details for the remainder.</p>" : "") : "") +
        scenarioFlowLink(row) + "</section>";
    }).join("") + (failed.length > 50 ? '<p class="field-help">Showing 50 of ' + failed.length +
      " failed scenarios. Open the original detail report for the remainder.</p>" : "") :
      '<p class="inline-warning">The overview reports a failure, but no failed scenario details were recorded. The reason is unavailable.</p>');
  }

  function scenarioFlowLink(row) {
    return '<p class="report-originals report-scenario-link">' + (row.flowUrl ?
      originalLink(row.flowUrl, "Open scenario flow report") :
      '<span class="field-help">' + escape(row.flowError) + "</span>") + "</p>";
  }

  function parseResponse(node) {
    var result = { response: "", citFilter: "", tables: [], warnings: [] };
    if (!node) { return result; }
    var copy = node.cloneNode(true);
    var acceptedHeaders = [
      ["cit filter"], ["field"], ["rule"], ["expected value"], ["operation"],
      ["num. of matched cit(s)", "number of matched cit(s)"],
      ["matched cit#id list", "matched cit id list"], ["values in cit(s)"]
    ];
    copy.querySelectorAll("table").forEach(function (table) {
      var header = table.rows[0];
      if (!header || header.cells.length !== citColumns.length ||
          !acceptedHeaders.every(function (names, index) {
            return names.indexOf(compact(header.cells[index]).toLowerCase()) >= 0;
          })) { return; }
      var rows = [], length = 0, truncated = false;
      Array.from(table.rows).slice(1).forEach(function (row) {
        if (row.cells.length !== citColumns.length) {
          result.warnings.push("A CIT results row has an unexpected number of columns. Open the original report for that row.");
          return;
        }
        var cells = Array.from(row.cells).map(text);
        length += cells.join("").length;
        if (rows.length >= maxItems || length > maxDiagnostic) { truncated = true; return; }
        rows.push(cells);
      });
      if (truncated) { result.warnings.push("CIT results table truncated for display. Open the original report for all rows."); }
      result.tables.push(rows);
      table.replaceWith(document.createTextNode("\n"));
    });
    var value = text(copy).split(/\r?\n/).filter(function (line) {
      return !/^\s*(?:Stacktrace:\s*$|at\s+|\.{3}\s+\d+\s+more\s*$)/i.test(line);
    }).map(function (line) { return line.trim(); }).join("\n").trim();
    var marker = /\bCIT filter\s*:\s*/i.exec(value);
    if (marker) {
      var before = value.slice(0, marker.index).trim(), rest = value.slice(marker.index + marker[0].length);
      var close = rest.indexOf("}");
      if (rest.charAt(0) === "{" && close >= 0) {
        result.citFilter = boundedDiagnostic(rest.slice(1, close).trim());
        value = [before, rest.slice(close + 1).trim()].filter(Boolean).join("\n");
      } else {
        result.citFilter = boundedDiagnostic(rest.trim());
        value = before;
      }
    }
    result.response = boundedDiagnostic(value);
    return result;
  }
  function scenarioDiagnostics(row) {
    function disclosure(title, value) {
      return value ? '<details class="report-diagnostic-section"><summary>' + title +
        '</summary><pre class="report-diagnostic">' + escape(value) + "</pre></details>" : "";
    }
    var response = row.diagnostics;
    return disclosure("Description", row.description) + disclosure("Response Details", response.response) +
      scenarioFlowLink(row) +
      disclosure("CIT filter", response.citFilter) + warningsHtml(response.warnings) +
      response.tables.map(function (rows, index) {
        return '<section class="report-cit-section"><h3>CIT validation results' +
          (response.tables.length > 1 ? " " + (index + 1) : "") +
          '</h3><p class="field-help">Red rows indicate a bracketed CIT value differs from the expected value.</p>' +
          '<div class="report-cit-scroll" role="region" aria-label="CIT validation results table" tabindex="0">' +
          '<table class="report-cit-table"><caption class="sr-only">CIT filter matching results</caption><thead><tr>' +
          citColumns.map(function (name) { return '<th scope="col">' + name + "</th>"; }).join("") +
          "</tr></thead><tbody>" + rows.map(function (cells) {
            return (citValueMismatch(cells) ?
              '<tr class="report-cit-mismatch" title="CIT value differs from expected value">' : "<tr>") +
              cells.map(function (cell) { return "<td>" + escape(cell) + "</td>"; }).join("") + "</tr>";
          }).join("") + "</tbody></table></div></section>";
      }).join("") +
      (!response.response && !response.citFilter && !response.tables.length ?
        '<p class="field-help">' + (row.status === "failed" ? "No failure diagnostics were included." : "No run error text reported.") + "</p>" : "");
  }
  function scenarioFlow(node, index, pageUrl) {
    var buttons = node.querySelectorAll('[id="log_btn_' + index + '"]');
    if (!buttons.length) { return { error: "No scenario flow report link was recorded." }; }
    try {
      if (buttons.length !== 1) { throw new Error("Ambiguous scenario flow report links."); }
      var call = (buttons[0].getAttribute("onclick") || "").match(/^\s*window\.open\(\s*(['"])([^'"]+)\1\s*\)\s*;?\s*$/);
      if (!call || !pageUrl) { throw new Error("Unsupported scenario flow report link."); }
      return { url: safeLink(call[2], pageUrl, new URL(".", pageUrl).href) };
    } catch (error) { return { error: "Scenario flow report unavailable: " + error.message }; }
  }
  function parseDetails(html, pageUrl) {
    var dom = documentFor(html), seen = {};
    var nodes = Array.from(dom.querySelectorAll("div[id]")).filter(function (node) {
      return /^_TEST-(PASSED|FAILED|SKIPPED)-\d+$/.test(node.id);
    });
    if (!nodes.length) { throw new Error("No supported scenario results found in this detail report."); }
    if (nodes.length > maxItems) { throw new Error("Too many scenarios to display. Open the original report."); }
    return nodes.map(function (node) {
      if (seen[node.id]) { throw new Error("Duplicate scenario identifiers in detail report."); }
      seen[node.id] = true;
      var index = node.id.match(/(\d+)$/)[1];
      var flow = scenarioFlow(node, index, pageUrl);
      return { id: node.id, status: node.id.match(/^_TEST-(\w+)-/)[1].toLowerCase(),
        flowUrl: flow.url || "", flowError: flow.error || "",
        name: compact(node.querySelector("p")) || "Scenario " + index,
        description: diagnostic(node.querySelector('[id="_DESCRIPTION-' + index + '-DETAIL"]')),
        diagnostics: parseResponse(node.querySelector('[id="_STACKTRACE-' + index + '-DETAIL"]')) };
    });
  }

  function pieChart(title, values) {
    var valid = validCounts(values), total = values.total, start = -Math.PI / 2, shapes = "";
    if (valid && total > 0) {
      outcomes.forEach(function (status) {
        var value = values[status];
        if (!value) { return; }
        var angle = value / total * Math.PI * 2, end = start + angle;
        if (value === total) {
          shapes += '<circle class="report-slice--' + status + '" cx="100" cy="100" r="88"/>';
        } else {
          shapes += '<path class="report-slice--' + status + '" d="M100 100 L' +
            (100 + 88 * Math.cos(start)) + " " + (100 + 88 * Math.sin(start)) +
            " A88 88 0 " + (angle > Math.PI ? 1 : 0) + " 1 " +
            (100 + 88 * Math.cos(end)) + " " + (100 + 88 * Math.sin(end)) + ' Z"/>';
        }
        start = end;
      });
    }
    var legend = outcomes.map(function (status) {
      return '<li><span class="report-dot report-slice--' + status + '" aria-hidden="true"></span><span>' +
        status.charAt(0).toUpperCase() + status.slice(1) + "</span><strong>" +
        (values[status] === null ? "Unknown" : values[status]) + "</strong><span>" +
        (valid && total ? (values[status] / total * 100).toFixed(1) + "%" : "\u2014") + "</span></li>";
    }).join("");
    var description = outcomes.map(function (status) { return status + ": " + (values[status] === null ? "unknown" : values[status]); }).join(", ");
    return '<section class="report-chart"><h2>' + escape(title) + '</h2><p class="field-help">Report-wide totals</p>' +
      (shapes ? '<svg viewBox="0 0 200 200" role="img" aria-label="' + escape(title + ". " + description) +
        '"><title>' + escape(title) + "</title><desc>" + escape(description) + "</desc>" + shapes + "</svg>" :
        '<p class="report-chart__empty">' + (valid ? "No results" : "Chart unavailable: inconsistent or missing totals") + "</p>") +
      '<p class="report-chart__total">Total: <strong>' + (total === null ? "Unknown" : total) +
      '</strong></p><ul class="report-legend">' + legend + "</ul></section>";
  }
  function statusBadge(status) {
    return '<span class="report-status report-status--' + status + '">' + status.toUpperCase() + "</span>";
  }
  function warningsHtml(warnings) {
    return warnings.length ? '<div class="inline-warning"><ul>' +
      warnings.map(function (warning) { return "<li>" + escape(warning) + "</li>"; }).join("") + "</ul></div>" : "";
  }
  function originalLink(url, label) {
    return '<a class="report-original" target="_blank" rel="noopener noreferrer" href="' + escape(url) + '">' + escape(label) + "</a>";
  }
  function countLabel(value) { return value === null ? "unknown" : String(value); }

  async function readHtml(url, signal, root) {
    var response = await fetch(url, { signal: signal, cache: "no-store", redirect: root ? "error" : "follow" });
    if (!response.ok) { throw new Error(response.status === 404 ? "No report is available at this location." : "Unable to load report (HTTP " + response.status + ")."); }
    var finalUrl = root ? safeLink(response.url, url, root) : sourceUrl(response.url);
    if (Number(response.headers.get("Content-Length")) > maxBytes) { throw new Error("Report exceeds the 8 MiB display limit."); }
    var reader = response.body.getReader(), decoder = new TextDecoder(), content = "", size = 0;
    try {
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) { break; }
        size += chunk.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error("Report exceeds the 8 MiB display limit."); }
        content += decoder.decode(chunk.value, { stream: true });
      }
      content += decoder.decode();
    } finally { reader.releaseLock(); }
    return { url: finalUrl, html: content };
  }

  async function readBatch(page, signal) {
    var dom = documentFor(page.html), manifest = dom.querySelector("#app-batch-report");
    if (!manifest) { return null; }
    var entries = Array.from(manifest.children), root = new URL(".", sourceUrl(page.url)).href;
    if (!entries.length || entries.length > 100) { throw new Error("Invalid batch report target count."); }
    var model = { url: page.url, root: root, suites: [], tests: counts(0, 0, 0, 0),
      scenarios: counts(0, 0, 0, 0), suiteCounts: counts(0, 0, 0, 0), warnings: [],
      created: manifest.getAttribute("data-created") || "Not reported",
      environment: manifest.getAttribute("data-environment") || "Not reported", duration: "Not reported", batch: true, targets: [] };
    var seconds = 0, knownDuration = true, incomplete = false, totalTests = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i], name = entry.getAttribute("data-batch-target");
      var state = entry.getAttribute("data-status"), link = entry.querySelector("a[href]");
      if (!name || ["pending", "running", "completed", "failed"].indexOf(state) < 0) {
        throw new Error("Invalid batch target entry.");
      }
      model.targets.push(name + ": " + state);
      try {
        if (state === "pending" || state === "running") { throw new Error("Target is " + state + "; refresh after the batch completes."); }
        if (!link) { throw new Error("No report was generated. " + compact(entry.querySelector("[data-batch-error]"))); }
        var targetUrl = safeLink(link.getAttribute("href"), page.url, root);
        var source = await readHtml(targetUrl, signal, root);
        var target = parseOverview(source.html, source.url);
        try {
          orderSuites(target, [{ target: name, suites: Array.from(entry.querySelectorAll("[data-batch-suite]"))
            .map(function (suite) { return { name: compact(suite) }; }) }]);
        } catch (error) { model.warnings.push(name + ": " + error.message + " Original suite order retained."); }
        totalTests += target.suites.reduce(function (sum, suite) { return sum + suite.tests.length; }, 0);
        if (totalTests > maxItems || model.suites.length + target.suites.length > maxItems) {
          throw new Error("Combined report exceeds the display limit.");
        }
        target.suites.forEach(function (suite) {
          suite.id = "batch-" + i + "-" + suite.id;
          suite.name = name + " / " + suite.name;
          suite.tests.forEach(function (test) {
            test.id = "batch-" + i + "-" + test.id;
            test.overview = source;
          });
        });
        model.suites = model.suites.concat(target.suites);
        ["tests", "scenarios", "suiteCounts"].forEach(function (key) {
          Object.keys(model[key]).forEach(function (status) {
            model[key][status] = model[key][status] === null || target[key][status] === null ?
              null : model[key][status] + target[key][status];
          });
        });
        model.warnings = model.warnings.concat(target.warnings.map(function (warning) { return name + ": " + warning; }));
        if (state === "failed" && !target.tests.failed && !target.scenarios.failed) {
          model.warnings.push(name + ": execution failed (exit " + entry.getAttribute("data-exit-code") +
            "). Available results are included; inspect the batch log for execution errors.");
        }
        var elapsed = target.duration.match(/^(\d+(?:\.\d+)?) s$/);
        if (elapsed) { seconds += Number(elapsed[1]); } else { knownDuration = false; }
      } catch (error) {
        if (error.name === "AbortError") { throw error; }
        incomplete = true;
        model.warnings.push(name + ": " + error.message);
      }
    }
    if (incomplete) {
      ["tests", "scenarios", "suiteCounts"].forEach(function (key) { model[key] = counts(null, null, null, null); });
      model.warnings.push("Batch results are incomplete. Available results are shown; combined totals remain unknown.");
    }
    model.duration = knownDuration && !incomplete ? seconds.toFixed(2) + " s" : "Not reported";
    return model;
  }

  function create(screen) {
    var model = null, snapshot = "", controller = null, sequence = 0, visible = false;
    var cache = new Map(), pending = new Map();
    var summary = screen.querySelector("#report-summary"), results = screen.querySelector("#report-results");
    var message = screen.querySelector("#report-message"), search = screen.querySelector("#report-search");
    var filter = screen.querySelector("#report-filter"), source = screen.querySelector("#report-original");
    var scenarioFilter = screen.querySelector("#report-scenario-filter");
    var suiteFilter = screen.querySelector("#report-suite-filter");
    var failures = screen.querySelector("#report-failures");
    var orderNote = screen.querySelector("#report-order-note");
    var refresh = screen.querySelector("#report-refresh");
    function selectedStatuses(group) {
      if (group.querySelector('[data-status="all"]').getAttribute("aria-pressed") === "true") { return outcomes; }
      return Array.from(group.querySelectorAll('button[aria-pressed="true"]')).map(function (button) {
        return button.getAttribute("data-status");
      });
    }
    function bindStatusButtons(group, onChange) {
      var buttons = group.querySelectorAll("button[data-status]");
      var all = group.querySelector('[data-status="all"]');
      buttons.forEach(function (button) {
        button.addEventListener("click", function () {
          if (button === all) {
            buttons.forEach(function (item) { item.setAttribute("aria-pressed", String(item === all)); });
          } else {
            all.setAttribute("aria-pressed", "false");
            button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
            if (!selectedStatuses(group).length) { all.setAttribute("aria-pressed", "true"); }
          }
          onChange();
        });
      });
    }
    function filterScenarios(target) {
      var rows = target.querySelectorAll("[data-scenario-status]"), shown = 0, statuses = selectedStatuses(scenarioFilter);
      rows.forEach(function (row) {
        row.hidden = statuses.indexOf(row.getAttribute("data-scenario-status")) < 0;
        if (!row.hidden) { shown++; }
      });
      var count = target.querySelector(".report-scenario-count");
      if (count) {
        count.textContent = shown ? shown + " of " + rows.length + " scenarios shown." :
          "No scenarios match the selected statuses (" + rows.length + " total).";
      }
    }
    function renderResults() {
      if (!model) { return; }
      var query = search.value.trim().toLowerCase(), shown = 0, shownSuites = 0, statuses = selectedStatuses(filter);
      var suiteStatuses = selectedStatuses(suiteFilter);
      results.innerHTML = model.suites.map(function (suite) {
        if (suiteStatuses.indexOf(suite.status) < 0) { return ""; }
        var tests = suite.tests.filter(function (test) {
          return statuses.indexOf(test.status) >= 0 &&
            (suite.name + " " + test.name).toLowerCase().indexOf(query) >= 0;
        });
        if (!tests.length) { return ""; }
        shownSuites++;
        shown += tests.length;
        return '<section class="report-suite"><header><h2>' + escape(suite.name) +
          '</h2><span>Suite status: ' + statusBadge(suite.status) + '</span><p class="field-help">Duration: ' +
          escape(suite.duration) + "</p></header>" + warningsHtml(suite.warnings) +
          tests.map(function (test) {
            return '<details class="report-test" data-report-test="' + escape(test.id) + '"><summary><span>' +
              escape(test.name) + "</span>" + statusBadge(test.status) + '</summary><div class="report-test__body"><p>Duration: ' +
              escape(test.duration) + " · Scenarios: " + countLabel(test.counts.passed) + " passed, " +
              countLabel(test.counts.failed) + " failed, " + countLabel(test.counts.skipped) + " skipped</p>" +
              warningsHtml(test.warnings) + '<div class="report-scenarios" aria-live="polite"></div></div></details>';
          }).join("") + "</section>";
      }).join("") || '<p class="empty">No test results match these filters.</p>';
      screen.querySelector("#report-result-count").textContent = shownSuites + " suites and " + shown + " tests shown. Charts remain report-wide.";
      results.querySelectorAll("[data-report-test]").forEach(function (details) {
        details.addEventListener("toggle", function () { if (details.open) { loadDetails(details); } });
      });
    }
    async function getDetails(test) {
      var id = test.id;
      if (!test.links.length) { throw new Error("Details are unavailable; use the original report."); }
      if (test.links.length > 32) { throw new Error("More than 32 detail pages; open the original report."); }
      if (cache.has(id)) { return cache.get(id); }
      if (pending.has(id)) { return pending.get(id); }
      var current = sequence, selectedModel = model, selectedSnapshot = snapshot, signal = controller.signal;
      var request = (async function () {
        var check = await readHtml(selectedModel.url, signal, selectedModel.root);
        if (check.html !== selectedSnapshot) { throw new Error("Report changed since it was opened. Refresh before loading details."); }
        if (test.overview) {
          var original = await readHtml(test.overview.url, signal, selectedModel.root);
          if (original.html !== test.overview.html) { throw new Error("Target report changed. Refresh before loading details."); }
        }
        var rows = [], links = [], issue = test.warnings.slice();
        for (var link of test.links) {
          var page = await readHtml(link, signal, selectedModel.root);
          rows = rows.concat(parseDetails(page.html, page.url));
          if (rows.length > maxItems) { throw new Error("Too many scenarios to display. Open the original report."); }
          links.push(page.url);
        }
        if (!sameCounts(outcomeCounts(rows), test.counts)) { issue.push("Detailed scenario counts differ from the overview. Report may be incomplete or changing."); }
        return { rows: rows, links: links, warnings: issue };
      }());
      pending.set(id, request);
      try {
        var data = await request;
        if (current === sequence && visible) { cache.set(id, data); }
        return data;
      } finally { if (pending.get(id) === request) { pending.delete(id); } }
    }
    async function loadDetails(details) {
      if (!model || !visible || !details.isConnected) { return; }
      var id = details.getAttribute("data-report-test"), target = details.querySelector(".report-scenarios");
      var test = model.suites.flatMap(function (suite) { return suite.tests; }).find(function (item) { return item.id === id; });
      if (!test) { return; }
      var current = sequence;
      target.textContent = "Loading scenario results…";
      try {
        var data = await getDetails(test);
        if (current !== sequence || !visible) { return; }
        if (details.isConnected) {
          target.innerHTML = warningsHtml(data.warnings) + '<p class="report-originals">' + data.links.map(function (url) {
            return originalLink(url, "Open original detail report");
          }).join(" · ") + '</p><p class="field-help report-scenario-count" role="status"></p>' +
            data.rows.map(function (row) {
              return '<details class="report-scenario" data-scenario-status="' + row.status + '"' + (row.status === "failed" ? " open" : "") +
                "><summary>" + statusBadge(row.status) + "<span>" + escape(row.name) +
                "</span></summary>" + scenarioDiagnostics(row) + "</details>";
            }).join("");
          filterScenarios(target);
        }
      } catch (error) {
        if (current !== sequence || !visible || error.name === "AbortError") { return; }
        target.innerHTML = '<p class="inline-error" role="alert">' + escape(error.message) +
          '</p><button type="button" class="button">Retry details</button>';
        target.querySelector("button").onclick = function () { loadDetails(details); };
      }
    }
    async function loadFailure(test, target, current) {
      target.innerHTML = '<p class="field-help" role="status">Loading failure reasons…</p>';
      try {
        var data = await getDetails(test);
        if (current !== sequence || !visible || !target.isConnected) { return; }
        target.innerHTML = failureScenarios(data);
      } catch (error) {
        if (current !== sequence || !visible || !target.isConnected || error.name === "AbortError") { return; }
        target.innerHTML = '<p class="inline-error" role="alert">Failure reason unavailable: ' + escape(error.message) +
          '</p><button class="button" type="button">Retry failure details</button>';
        target.querySelector("button").onclick = function () { loadFailure(test, target, current); };
      }
    }
    function renderFailures() {
      var candidates = [];
      model.suites.forEach(function (suite) {
        suite.tests.forEach(function (test) {
          if (test.status === "failed" || test.counts.failed > 0) { candidates.push({ suite: suite, test: test }); }
        });
      });
      failures.hidden = false;
      failures.innerHTML = '<summary><h2>Summary</h2></summary><p class="field-help">Report-wide; unaffected by status filters or search.</p>' +
        (model.warnings.length ? '<p class="inline-warning">Report totals are incomplete or inconsistent. Available failure entries are shown; see report warnings above.</p>' : "") +
        (candidates.length ? candidates.map(function (item) {
          return '<section class="report-failure-test"><h3>' + escape(item.test.name) + "</h3><p>" +
            escape(item.suite.name) + " · Reported test status: " + statusBadge(item.test.status) +
            '</p><div class="report-failure-content" aria-live="polite"><p class="field-help" role="status">Waiting for failure details…</p></div></section>';
        }).join("") : '<p role="status">' + (!model.warnings.length && model.tests.failed === 0 && model.scenarios.failed === 0 ?
          "No failed tests or scenarios were reported." : "Failure entries could not be identified reliably. Open the original report to inspect the results.") + "</p>");
      var targets = failures.querySelectorAll(".report-failure-content"), next = 0, current = sequence;
      async function worker() {
        while (next < candidates.length && current === sequence && visible) {
          var index = next++;
          await loadFailure(candidates[index].test, targets[index], current);
        }
      }
      worker();
      worker();
    }
    async function load() {
      if (controller) { controller.abort(); }
      controller = new AbortController();
      var current = ++sequence;
      model = null; cache.clear(); pending.clear(); summary.innerHTML = ""; results.innerHTML = "";
      failures.innerHTML = ""; failures.hidden = true; failures.open = false;
      orderNote.textContent = ""; orderNote.className = "field-help";
      screen.querySelector("#report-result-count").textContent = "";
      message.className = "field-help"; message.textContent = "Loading existing report…";
      refresh.disabled = true; source.href = "/api/report";
      try {
        var page = await readHtml("/api/report", controller.signal);
        var next = await readBatch(page, controller.signal) || parseOverview(page.html, page.url);
        var orderingMessage, orderingFailed = false;
        try {
          if (next.batch) {
            orderingMessage = "Combined report: targets and suites follow the test.xml order saved when the batch started. Repeated suites count once per execution.";
          } else {
            var ordering = await fetch("/api/report-suite-order", { signal: controller.signal, cache: "no-store" });
            if (!ordering.ok) { throw new Error("Unable to read test.xml suite order (HTTP " + ordering.status + ")."); }
            orderingMessage = orderSuites(next, await ordering.json());
          }
        } catch (error) {
          if (error.name === "AbortError") { throw error; }
          orderingFailed = true;
          orderingMessage = error.message + " Original report order retained. Refresh to retry.";
        }
        if (current !== sequence || !visible) { return; }
        orderNote.textContent = orderingMessage;
        orderNote.className = orderingFailed ? "inline-warning" : "field-help";
        model = next; snapshot = page.html;
        source.href = model.url;
        summary.innerHTML = '<div class="report-metadata"><p><strong>Report created:</strong> ' +
          escape(model.created) + " · <strong>Duration:</strong> " + escape(model.duration) +
          (model.batch ? " · <strong>Batch environment:</strong> " + escape(model.environment) : "") +
          '</p><p class="field-help">Source: ' + escape(decodeURIComponent(new URL(model.url).pathname)) +
          '. These are saved results, not the current environment selection.</p></div>' +
          (model.batch ? '<p class="field-help">' + model.targets.map(escape).join(" · ") + "</p>" : "") +
          warningsHtml(model.warnings) + '<div class="report-charts">' +
          pieChart("Suite results", model.suiteCounts) +
          pieChart("Test results", model.tests) + pieChart("Scenario results", model.scenarios) +
          '</div><p class="field-help">Suite totals represent the TestNG XML suites in this saved report: failed if any test fails, skipped if all tests are skipped, otherwise passed. Empty suites retain their reported status.</p>';
        message.textContent = "Existing report loaded. Refresh after a run to read newly generated results.";
        renderResults();
        renderFailures();
      } catch (error) {
        if (current !== sequence || !visible || error.name === "AbortError") { return; }
        message.className = "inline-error"; message.textContent = error.message + " Use Refresh to retry or open the original report.";
      } finally { if (current === sequence) { refresh.disabled = false; } }
    }
    refresh.addEventListener("click", load);
    search.addEventListener("input", renderResults);
    bindStatusButtons(filter, renderResults);
    bindStatusButtons(suiteFilter, renderResults);
    bindStatusButtons(scenarioFilter, function () {
      results.querySelectorAll(".report-scenarios").forEach(filterScenarios);
    });
    return {
      show: function () { if (!visible) { visible = true; load(); } },
      hide: function () { visible = false; ++sequence; if (controller) { controller.abort(); } }
    };
  }
  window.ChargingReport = { create: create, parseOverview: parseOverview, parseDetails: parseDetails,
    pieChart: pieChart, safeLink: safeLink, orderSuites: orderSuites, readBatch: readBatch };
}());
