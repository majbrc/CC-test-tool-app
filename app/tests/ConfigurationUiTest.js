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
eval(section("  var commonValueOptions =", "  var currentSuite ="));
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
check(commonHtml.indexOf("common-type") === -1 && commonHtml.indexOf("data-common-suite-type") === -1 &&
  commonHtml.indexOf("Editor type") === -1 && commonHtml.indexOf("type-only") === -1,
  "common values have no type controls or type instructions");
check(commonHtml.indexOf("data-common-input=") === -1, "no editable resolved common value");
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
var literalProperty = { name: "START_MILLIS", mixed: false, mixedType: true,
  values: [{value:"123"}], files: [{path:"input.xml",value:"123",editorType:"number"}], tests:["test-A"] };
var literalHtml = renderCommon({properties:[literalProperty]}, "suite.xml");
check(literalHtml.indexOf(">Value for START_MILLIS</label>") !== -1 &&
  literalHtml.indexOf('value="123"') !== -1,
  "literal values remain editable");
check(literalHtml.indexOf('<th scope="col">Property Name</th>') !== -1 &&
  literalHtml.indexOf('<th scope="col">Value</th>') !== -1 &&
  literalHtml.indexOf('<th scope="col">Edit Parameter</th>') !== -1 &&
  literalHtml.indexOf('<tr class="common-property"><th scope="row">START_MILLIS</th>') !== -1,
  "common properties use a semantic three-column table with property row headings");
[literalHtml, commonHtml].forEach(function (rendered) {
  check(rendered.indexOf("input file(s)") === -1 && rendered.indexOf("referencing test(s)") === -1 &&
    rendered.indexOf("Current:") === -1 && rendered.indexOf("Review changes to matching XML constants.") === -1 &&
    rendered.indexOf("Parameter declaration defaults and scenario values remain unchanged.") === -1,
    "common cards omit redundant counts, current-value text and review explanation");
});
check(literalHtml.indexOf('class="common-timestamp" data-common-timestamp=') !== -1 &&
  literalHtml.indexOf("Switch to fixed Vilnius date and time") !== -1,
  "timestamp helper remains available without a type selector");
literalProperty.name = "CUSTOM_TIME";
literalProperty.files[0].editorType = "unixTimestamp";
check(renderCommon({properties:[literalProperty]}, "suite.xml")
  .indexOf('class="common-timestamp" data-common-timestamp=') !== -1,
  "previous timestamp hints retain optional date/time assistance");
literalProperty.mixed = true;
literalProperty.values.push({value:"456"});
var mixedHtml = renderCommon({properties:[literalProperty]}, "suite.xml");
check(mixedHtml.indexOf("Mixed values across XML constants.") !== -1 &&
  mixedHtml.indexOf("Mixed values — enter one common value") !== -1 &&
  mixedHtml.indexOf('data-common-input=') !== -1,
  "mixed values remain editable");
check(literalHtml.indexOf('data-common-save=') === -1 &&
  literalHtml.indexOf('>Save</button>') === -1 &&
  literalHtml.indexOf('data-common-status') !== -1 &&
  literalHtml.indexOf("Review common constants value") === -1,
  "common values show autosave status instead of a Save button");
check(literalHtml.indexOf("common-type") === -1 && mixedHtml.indexOf("common-type") === -1,
  "literal and mixed cards omit per-entry type details");
var customer = {name:"CUSTOMER_TYPE",values:[{value:"Custom customer"}],files:[],tests:[]};
var customerHtml = renderCommon({properties:[customer]}, "suite.xml");
check(customerHtml.indexOf('aria-controls="common-suite-xml-0-options"') !== -1 &&
  customerHtml.indexOf('role="combobox"') !== -1 &&
  customerHtml.indexOf('data-common-option="B2B"') !== -1 && customerHtml.indexOf('data-common-option="B2C"') !== -1 &&
  customerHtml.indexOf('type="text" data-common-input=') !== -1 &&
  customerHtml.indexOf('value="Custom customer"') !== -1 && customerHtml.indexOf('pattern=') === -1,
  "customer type offers B2B and B2C suggestions while retaining arbitrary typed values");
customer.values[0].value = "${CUSTOMER_KIND}";
check(renderCommon({properties:[customer]}, "suite.xml").indexOf("common-combobox") === -1,
  "parameterized customer type retains protected expression editing");
check(literalHtml.indexOf("common-combobox") === -1, "other common values do not gain customer-type suggestions");
var ratePlanHtml = renderCommon({properties:[{name:"RATE_PLAN",values:[{value:"CUSTOM_PLAN"}],files:[]}]}, "suite.xml");
check(ratePlanHtml.indexOf('data-common-option="TARNYBINIS_MHS"') !== -1 &&
  ratePlanHtml.indexOf('data-common-option="TELIA_FAM_30GB_MHS_C"') === -1 &&
  ratePlanHtml.indexOf('value="CUSTOM_PLAN"') !== -1 &&
  ratePlanHtml.indexOf('aria-label="Show RATE_PLAN options"') !== -1,
  "rate-plan dropdown includes current plans, omits expired plans and permits custom values");
check(code.indexOf('data-common-suite-type') === -1 && code.indexOf('data-common-type-preview') === -1,
  "removed common type controls have no event handlers");
check(code.indexOf('data-type-field') !== -1 && code.indexOf('operation: "type"') !== -1,
  "other configuration sections retain type controls");
check(displayValue("${UNKNOWN}", { parameterized: true, status: "runtime" }) === "Determined at runtime",
  "runtime value is not invented");
["$_TEST_DIR/templates/${ABC}.xml", "${_TEST_DIR}/templates/${ABC}.xml"].forEach(function (path) {
  check(displayValue(path, { parameterized: true, status: "resolved", value: "incorrect" }) === path,
    "_TEST_DIR path remains exactly as stored");
  check(safeDisplay(path).sources.length === 0, "directory path has no source resolution");
});
print("ConfigurationUiTest passed");
