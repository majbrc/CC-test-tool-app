var file = java.nio.file.Paths.get("app", "web", "app.js");
var code = String(new java.lang.String(java.nio.file.Files.readAllBytes(file), "UTF-8"));
new javax.script.ScriptEngineManager().getEngineByName("nashorn").compile(code);

function section(from, to) {
  var start = code.indexOf(from), end = code.indexOf(to, start);
  if (start < 0 || end < 0) { throw new Error("Missing renderer: " + from); }
  return code.substring(start, end);
}
function check(condition, message) {
  if (!condition) { throw new Error(message); }
}
var sourceDestinations = {}, sourceSequence = 0, technicalPanelSequence = 0;
var modelFields = {}, modelFieldSequence = 0;
var escapeHtml = function (value) { return String(value == null ? "" : value); };
var label = function (value) { return value; };
var referenceChips = function () { return ""; };
var renderValidations = function () { return ""; };
eval(section("  function expressionBacked(", "  function referenceChips("));
eval(section("  function renderScenarios(", "  function renderTestObject("));
eval(section("  function renderCommon(", "  function renderSuiteModel("));

var six = ["ciPropertiesFile", "sapCcApi", "generateCit", "onErrorFailTheTest", "testExtension", "errorMessage"];
var ordinary = ["id", "amount", "fwOnErrorFailTheTest"];
var fields = ordinary.concat(six).map(function (name) {
  return { name: name, label: name, value: name === "id" ? "100" : "literal", type: "string" };
});
var html = renderScenarios({
  userDefinition: false, scenarios: [{ id: "100", fields: fields }, { id: "200", fields: fields }]
}, []);
check((html.match(/>Technical Details<\/button>/g) || []).length === 2, "one button per test case");
var panelStart = html.indexOf('id="technical-panel-1" hidden');
ordinary.forEach(function (name) {
  check(html.indexOf(">" + name + "</label>") < panelStart, name + " remains outside technical details");
});
six.forEach(function (name) {
  check(html.indexOf(">" + name + "</label>") > panelStart, name + " starts in technical details");
});
check(html.indexOf('aria-controls="technical-panel-1" aria-expanded="false"') !== -1 &&
  html.indexOf('aria-controls="technical-panel-2" aria-expanded="false"') !== -1, "independent accessible panels");
check(renderScenarios({ scenarios: [{ id: "plain", fields: fields.slice(0, 3) }] }, [])
  .indexOf("Technical Details") === -1, "no empty technical section");

var preview = { parameterized: true, status: "preview", value: "2030",
  evaluatedAt: "2030-01-01T00:00:00Z", zone: "Europe/Vilnius", sources: [] };
var common = { properties: [{ name: "Year", mixed: false, editorType: "string",
  values: [{ value: "${CURRENT_YEAR}", display: preview }],
  files: [{ path: "input.xml", sourcePath: "input.xml", nodePath: "0/0/0", attribute: "constValue",
    revision: "fixture-revision", value: "${CURRENT_YEAR}", display: preview }], tests: ["test-A"] }] };
var commonHtml = renderCommon(common, "suite.xml");
check(commonHtml.indexOf("<output>2030</output>") !== -1, "preview value displayed");
check(commonHtml.indexOf("Parameterized") !== -1 && commonHtml.indexOf("Preview") !== -1, "preview identified");
check(commonHtml.indexOf("<output>2030</output>") < commonHtml.indexOf("common-type-setting"),
  "common value before type");
check(commonHtml.indexOf("data-common-input=") === -1 &&
  commonHtml.indexOf('data-common-type-replace="0" disabled') !== -1, "no editable resolved common value");
check(commonHtml.indexOf("${CURRENT_YEAR}") > commonHtml.indexOf("Expression and sources"),
  "raw expression confined to details");

var resolved = fieldControl({ label: "example", value: "${ABC}", sourcePath: "input.xml",
  nodePath: "0/1", attribute: "paramValue", revision: "fixture-revision",
  display: { parameterized: true, status: "resolved", value: "actual", sources: [] } }, "test-field", {});
check(resolved.indexOf('<output id="test-field">actual</output>') !== -1 && resolved.indexOf("data-model-field") === -1,
  "constant display cannot become an autosave input");
check(resolved.indexOf('data-edit-expression="test-field">Edit source value</button>') !== -1,
  "explicit original expression editor is discoverable");
check(commonHtml.indexOf("data-expression-files=") !== -1, "common expressions offer exact XML-entry selection");
check(commonHtml.indexOf("data-edit-expression=") !== -1, "common XML entry has its own expression editor");
check(displayValue("${UNKNOWN}", { parameterized: true, status: "runtime" }) === "Determined at runtime",
  "runtime value is not invented");
["$_TEST_DIR/templates/${ABC}.xml", "${_TEST_DIR}/templates/${ABC}.xml"].forEach(function (path) {
  check(displayValue(path, { parameterized: true, status: "resolved", value: "incorrect" }) === path,
    "_TEST_DIR path remains exactly as stored");
  check(safeDisplay(path).sources.length === 0, "directory path has no source resolution");
});
print("ConfigurationUiTest passed");
