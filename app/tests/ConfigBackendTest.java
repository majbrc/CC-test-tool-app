import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class ConfigBackendTest {
    private static Path root;
    private static Object console;
    private static Method mutation;

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && "--live-preview".equals(args[0])) {
            Constructor<?> constructor = ChargingTestConsole.class.getDeclaredConstructor(Path.class);
            constructor.setAccessible(true);
            console = constructor.newInstance(Paths.get(".").toAbsolutePath());
            mutation = ChargingTestConsole.class.getDeclaredMethod("configMutation", Map.class, boolean.class);
            mutation.setAccessible(true);
            Method common = ChargingTestConsole.class.getDeclaredMethod("commonModel", String.class);
            common.setAccessible(true);
            Map<?, ?> model = (Map<?, ?>) common.invoke(console, "TEST/Telia_Acquire_CITs/suite-testng.xml");
            check(!((List<?>) model.get("properties")).isEmpty(), "live common discovery");
            preview(map("operation", "year", "mode", "fixed", "value", "2030"));
            preview(map("operation", "create", "suitePath", "TEST/Telia_Acquire_CITs/suite-testng.xml",
                    "sourceTestNodePath", "0/2", "name", "Preview-only test", "kind", "guided", "position", "after"));
            preview(map("operation", "create", "suitePath", "TEST/Telia_Test_Group_02/suite-testng.xml",
                    "sourceTestNodePath", "0/4", "name", "Preview-only test", "kind", "duplicate", "position", "after"));
            Map<String, Object> sessionPreview = preview(map("operation", "create",
                    "suitePath", "TEST/Telia_Session_Tests_Overspending/suite-testng.xml",
                    "sourceTestNodePath", "0/2", "name", "Preview-only test", "kind", "duplicate", "position", "after"));
            Map<?, ?> sessionData = (Map<?, ?>) sessionPreview.get("data");
            check(((List<?>) sessionData.get("newSessionPaths")).size() == 2, "live session copies");
            check(!((List<?>) sessionData.get("newValidationPaths")).isEmpty(), "live nested validation copies");
            System.out.println("Live read-only previews passed");
            return;
        }
        root = Paths.get("app", "tests", "config-fixture").toAbsolutePath();
        if (Files.exists(root)) throw new IllegalStateException("Fixture already exists: " + root);
        try {
            setup();
            Constructor<?> constructor = ChargingTestConsole.class.getDeclaredConstructor(Path.class);
            constructor.setAccessible(true);
            console = constructor.newInstance(root);
            mutation = ChargingTestConsole.class.getDeclaredMethod("configMutation", Map.class, boolean.class);
            mutation.setAccessible(true);
            testCommonAndStale();
            testCommonTypes();
            testDisplayResolution();
            testYear();
            testLabelsAndType();
            testCreation();
            testSessionIndependence();
            testSupportedKinds();
            testStagingFailure();
            testCommitRollback();
            testReportSuiteOrder();
            testBatchExecution();
            testBatchAntInvocation();
            System.out.println("ConfigBackendTest passed");
        } finally {
            if (Files.exists(root)) {
                List<Path> paths = new ArrayList<Path>();
                try (java.util.stream.Stream<Path> stream = Files.walk(root)) {
                    stream.sorted(java.util.Comparator.reverseOrder()).forEach(paths::add);
                }
                for (Path path : paths) Files.delete(path);
            }
        }
    }

    private static void testReportSuiteOrder() throws Exception {
        write("TEST/A/suite-order-10.xml", "<suite name=\"Tenth suite\"/>");
        write("TEST/A/suite-order-2.xml", "<suite name=\"Second suite\"/>");
        write("test.xml", "<project><target name=\"ordered\"><fileset dir=\"${basedir}/TEST/A\" id=\"orderedSuites\">"
                + "<include name=\"suite-order-2.xml\"/><!-- <include name=\"ignored.xml\"/> -->"
                + "<include name=\"suite-order-10.xml\"/></fileset>"
                + "<runMultipleSuites pXmlFilesetRef=\"orderedSuites\"/></target></project>");
        Method orderMethod = ChargingTestConsole.class.getDeclaredMethod("reportSuiteOrder");
        orderMethod.setAccessible(true);
        List<?> targets = (List<?>) orderMethod.invoke(console);
        Map<?, ?> target = (Map<?, ?>) targets.get(0);
        List<?> suites = (List<?>) target.get("suites");
        check(targets.size() == 1 && "ordered".equals(target.get("target")), "report order target");
        check(suites.size() == 2 && "Second suite".equals(((Map<?, ?>) suites.get(0)).get("name"))
                && "TEST/A/suite-order-10.xml".equals(((Map<?, ?>) suites.get(1)).get("path")),
                "report order follows explicit includes, ignoring comments and alphabetical ordering");
    }

    private static void testBatchExecution() throws Exception {
        String project = "<project basedir=\".\"><import file=\"build.xml\"/>";
        for (String name : Arrays.asList("first", "second")) {
            project += "<target name=\"" + name + "\"><fileset dir=\"${basedir}/TEST/A\" id=\"suites\">"
                    + "<include name=\"suite-order-2.xml\"/></fileset><runMultipleSuites pXmlFilesetRef=\"suites\">"
                    + "<config><sysproperty key=\"ccLandscape\" value=\"OVERRIDE\"/></config></runMultipleSuites></target>";
        }
        project += "</project>";
        write("test.xml", project);
        write("build.xml", "<project><macrodef name=\"runMultipleSuites\"><sequential><testng/></sequential></macrodef></project>");
        final byte[] saved = Files.readAllBytes(root.resolve("test.xml"));
        final byte[] savedConfig = Files.readAllBytes(root.resolve("install-package-sap-cc-unit-testing-framework-0.8.3/config/config.properties"));
        Method prepare = ChargingTestConsole.class.getDeclaredMethod("prepareBatch", Object.class);
        prepare.setAccessible(true);
        for (Object invalid : Arrays.asList("first", Arrays.asList(), Arrays.asList("first", "first"),
                Arrays.asList("missing"), Arrays.asList(1), Arrays.asList("first", "missing"))) {
            boolean rejected = false;
            try { prepare.invoke(console, invalid); } catch (InvocationTargetException ex) {
                rejected = ex.getCause().getMessage().contains("target") || ex.getCause().getMessage().contains("Target");
            }
            check(rejected, "Invalid batch selection rejected: " + invalid);
        }
        final Object batch = prepare.invoke(console, Arrays.asList("second", "first"));
        final List<String> executed = new ArrayList<String>();
        final List<Path> outputs = new ArrayList<Path>();
        final Class<?> runnerType = Class.forName("ChargingTestConsole$BatchExecutor");
        Object runner = java.lang.reflect.Proxy.newProxyInstance(runnerType.getClassLoader(), new Class<?>[] { runnerType },
                new java.lang.reflect.InvocationHandler() {
            public Object invoke(Object proxy, Method method, Object[] args) throws Exception {
                String target = (String) args[1];
                Path output = (Path) args[2];
                String xml = new String(Files.readAllBytes((Path) args[0]), StandardCharsets.UTF_8);
                check(xml.contains("value=\"RDEV\"") && !xml.contains("OVERRIDE"), "Batch snapshots replace explicit environment overrides");
                check(xml.contains("app.batch.failed") && xml.contains(output.toString()), "Batch snapshots isolate report paths and detect test failures");
                executed.add(target);
                outputs.add(output);
                Path report = output.resolve("user/Report.htm");
                Files.createDirectories(report.getParent());
                Files.write(report, ("<html>" + target + "</html>").getBytes(StandardCharsets.UTF_8));
                if ("first".equals(target)) {
                    write("install-package-sap-cc-unit-testing-framework-0.8.3/config/config.properties", "sap.cc.landscape=CHANGED\n");
                    return 1;
                }
                return 0;
            }
        });
        java.lang.reflect.Field current = ChargingTestConsole.class.getDeclaredField("runState");
        current.setAccessible(true);
        current.set(console, batch);
        Method execute = ChargingTestConsole.class.getDeclaredMethod("executeBatch", batch.getClass(), runnerType);
        execute.setAccessible(true);
        execute.invoke(console, batch, runner);
        Method statusMethod = ChargingTestConsole.class.getDeclaredMethod("runStatus");
        statusMethod.setAccessible(true);
        Map<?, ?> status = (Map<?, ?>) statusMethod.invoke(console);
        check(executed.equals(Arrays.asList("first", "second")), "Batch follows test.xml order and continues after failure");
        check(!outputs.get(0).equals(outputs.get(1)), "Repeated suite executions have isolated report directories");
        check(Integer.valueOf(1).equals(status.get("exitCode")) && Integer.valueOf(2).equals(status.get("completed"))
                && Boolean.FALSE.equals(status.get("running")), "Batch status aggregates failure and completed progress");
        check("RDEV".equals(status.get("environment")), "Active environment is captured once for the whole batch");
        check(Arrays.equals(saved, Files.readAllBytes(root.resolve("test.xml"))), "Saved target overrides remain byte-for-byte unchanged");
        Files.write(root.resolve("install-package-sap-cc-unit-testing-framework-0.8.3/config/config.properties"), savedConfig);
        Method find = ChargingTestConsole.class.getDeclaredMethod("findReport");
        find.setAccessible(true);
        Path merged = (Path) find.invoke(console);
        String manifest = new String(Files.readAllBytes(merged), StandardCharsets.UTF_8);
        check(manifest.contains("app-batch-report") && manifest.contains("targets/1/user/Report.htm")
                && manifest.contains("targets/2/user/Report.htm") && manifest.contains("data-batch-suite"),
                "Latest report persists both target sources and their saved suite order");
        check(manifest.indexOf("data-batch-target=\"first\"") < manifest.indexOf("data-batch-target=\"second\""),
                "Combined report retains batch execution order");
        Object single = prepare.invoke(console, Arrays.asList("second"));
        current.set(console, single);
        Object noReport = java.lang.reflect.Proxy.newProxyInstance(runnerType.getClassLoader(), new Class<?>[] {runnerType},
            new java.lang.reflect.InvocationHandler() {
                public Object invoke(Object proxy, Method method, Object[] args) { return 0; }
            });
        execute.invoke(console, single, noReport);
        status = (Map<?, ?>) statusMethod.invoke(console);
        check(Integer.valueOf(1).equals(status.get("exitCode")) &&
                ((Map<?, ?>) ((List<?>) status.get("batch")).get(0)).get("error").equals("No report was generated."),
                "One-target batches expose missing reports as failures instead of success");
    }

    private static void testBatchAntInvocation() throws Exception {
        write("BatchProbe.java", "public class BatchProbe { public static void main(String[] args) throws Exception {"
                + "if (!\"RDEV\".equals(System.getProperty(\"ccLandscape\"))) throw new Exception(\"Wrong environment\");"
                + "java.nio.file.Path report = java.nio.file.Paths.get(args[0], \"Report.htm\");"
                + "java.nio.file.Files.createDirectories(report.getParent());"
                + "java.nio.file.Files.write(report, \"<html>fixture</html>\".getBytes(\"UTF-8\"));"
                + "System.exit(Integer.parseInt(args[1])); }}");
        check(javax.tools.ToolProvider.getSystemJavaCompiler().run(null, null, null,
                "-d", root.toString(), root.resolve("BatchProbe.java").toString()) == 0, "Compile harmless Ant process fixture");
        write("build.xml", "<project><macrodef name=\"runMultipleSuites\">"
                + "<attribute name=\"pXmlFilesetRef\"/><attribute name=\"pTestLogDir\"/><attribute name=\"pTestNgReportDir\"/>"
                + "<element name=\"config\" optional=\"true\"/><sequential>"
                + "<java classname=\"BatchProbe\" classpath=\"${basedir}\" fork=\"true\" failonerror=\"false\" resultproperty=\"probe.exit\">"
                + "<config/><arg value=\"@{pTestNgReportDir}\"/><arg value=\"${probe.result}\"/></java>"
                + "<condition property=\"app.batch.failed\"><not><equals arg1=\"${probe.exit}\" arg2=\"0\"/></not></condition>"
                + "</sequential></macrodef></project>");
        String xml = "<project basedir=\".\"><import file=\"build.xml\"/>";
        for (String target : Arrays.asList("first", "second")) {
            xml += "<target name=\"" + target + "\"><delete dir=\"${testng.report.dir}\"/>"
                    + "<property name=\"probe.result\" value=\"" + ("first".equals(target) ? "1" : "0") + "\"/>"
                    + "<fileset dir=\"${basedir}/TEST/A\" id=\"suites\"><include name=\"suite-order-2.xml\"/></fileset>"
                    + "<runMultipleSuites pXmlFilesetRef=\"suites\"><config>"
                    + "<sysproperty key=\"ccLandscape\" value=\"OVERRIDE\"/></config></runMultipleSuites></target>";
        }
        write("test.xml", xml + "</project>");
        Method prepare = ChargingTestConsole.class.getDeclaredMethod("prepareBatch", Object.class);
        prepare.setAccessible(true);
        Object batch = prepare.invoke(console, Arrays.asList("first", "second"));
        Class<?> runnerType = Class.forName("ChargingTestConsole$BatchExecutor");
        final List<Integer> codes = new ArrayList<Integer>();
        Object runner = java.lang.reflect.Proxy.newProxyInstance(runnerType.getClassLoader(), new Class<?>[] {runnerType},
            new java.lang.reflect.InvocationHandler() {
                @SuppressWarnings("unchecked")
                public Object invoke(Object proxy, Method method, Object[] args) throws Exception {
                    Method commandMethod = ChargingTestConsole.class.getDeclaredMethod("antCommand", String.class, String.class);
                    commandMethod.setAccessible(true);
                    List<String> command = (List<String>) commandMethod.invoke(null, args[0].toString(), args[1]);
                    command.add("-Dtest.log.dir.path=" + args[2]);
                    command.add("-Dtestng.report.dir=" + ((Path) args[2]).resolve(System.getProperty("user.name", "")));
                    int code = new ProcessBuilder(command).directory(root.toFile()).redirectErrorStream(true)
                            .redirectOutput(ProcessBuilder.Redirect.appendTo(((Path) args[3]).toFile())).start().waitFor();
                    check(Files.isRegularFile(((Path) args[2]).resolve(System.getProperty("user.name", "")).resolve("Report.htm")),
                            "Forked fixture receives the captured environment and generates an isolated report");
                    codes.add(code);
                    return code;
                }
            });
        Method execute = ChargingTestConsole.class.getDeclaredMethod("executeBatch", batch.getClass(), runnerType);
        execute.setAccessible(true);
        execute.invoke(console, batch, runner);
        if (!codes.equals(Arrays.asList(1, 0))) {
            java.lang.reflect.Field log = batch.getClass().getDeclaredField("log");
            log.setAccessible(true);
            throw new AssertionError("Ant snapshot execution failed: " + new String(Files.readAllBytes((Path) log.get(batch)), StandardCharsets.UTF_8));
        }
        check(true, "Real Ant fixture passes fixed environment to forked JVMs, preserves basedir/imports and continues after failure");
    }

    private static void setup() throws Exception {
        Files.createDirectories(root.resolve("TEST/common/xsd"));
        Files.copy(Paths.get("TEST/common/xsd/test-inputs.xsd"), root.resolve("TEST/common/xsd/test-inputs.xsd"));
        Files.createDirectories(root.resolve("TEST/A"));
        Files.createDirectories(root.resolve("app/web"));
        Path config = root.resolve("install-package-sap-cc-unit-testing-framework-0.8.3/config");
        Files.createDirectories(config);
        write("test.xml", "<project/>");
        write("install-package-sap-cc-unit-testing-framework-0.8.3/config/config.properties", "sap.cc.landscape=RDEV\n");
        write("install-package-sap-cc-unit-testing-framework-0.8.3/config/sap.cc.RDEV.config.properties", "");
        String header = "<t:header><t:constants><t:constant name=\"_TEST_DIR\" constValue=\"TEST/A\"/>"
                + "<t:constant name=\"CURRENT_YEAR\" constValue=\"$DATE_TIME_NOW_items.Year\"/>"
                + "<t:constant name=\"USER_SERVICE_ID\" constValue=\"original\"/></t:constants>"
                + "<t:parameters><t:parameter name=\"amount\" type=\"string\" defaultValue=\"1\"/>"
                + "<t:parameter name=\"testExtension\" type=\"string\"/></t:parameters></t:header>";
        String scenarios = "<t:testData><t:test><t:id>1</t:id><t:labels>A,B</t:labels>"
                + "<t:parameter name=\"amount\" paramValue=\"2\"/><t:parameter name=\"testExtension\" paramValue=\"$_TEST_DIR/validation.xml\"/></t:test>"
                + "<t:test><t:id>2</t:id><t:labels>B</t:labels><t:parameter name=\"amount\" paramValue=\"oops\"/></t:test>"
                + "</t:testData>";
        write("TEST/A/test-input-user.xml", "<t:testTemplate xmlns:t=\"https://www.w3schools.com\">" + header + scenarios + "</t:testTemplate>");
        write("TEST/A/validation.xml", "<validation><value>unchanged</value></validation>");
        String test = "<test name=\"source\"><parameter name=\"xmlTemplateFile\" value=\"TEST/A/test-input-user.xml\"/>"
                + "<parameter name=\"testFilterLabel\" value=\"A:id|1|\"/><classes><class name=\"Example\"><methods>"
                + "<include name=\"t930_execute_charge\"/></methods></class></classes></test>";
        write("TEST/A/suite-main.xml", "<suite name=\"main\">" + test + "</suite>");
        write("TEST/A/suite-shared.xml", "<suite name=\"shared\">" + test + "</suite>");
    }

    private static void testCommonAndStale() throws Exception {
        Method common = ChargingTestConsole.class.getDeclaredMethod("commonModel", String.class);
        common.setAccessible(true);
        Map<?, ?> model = (Map<?, ?>) common.invoke(console, "TEST/A/suite-main.xml");
        List<?> properties = (List<?>) model.get("properties");
        check(properties.size() == 1, "common property discovery");
        Map<?, ?> property = (Map<?, ?>) properties.get(0);
        check(((List<?>) property.get("tests")).size() == 2, "shared suite impact");
        Map<String, Object> body = map("operation", "common", "suitePath", "TEST/A/suite-main.xml", "name", "USER_SERVICE_ID", "value", "new");
        Map<String, Object> preview = preview(body);
        check(((List<?>) preview.get("impact")).size() == 2, "shared change impact");
        byte[] before = Files.readAllBytes(root.resolve("TEST/A/test-input-user.xml"));
        Files.write(root.resolve("TEST/A/test-input-user.xml"), concat(before, "\n".getBytes(StandardCharsets.UTF_8)));
        expectFailure(body, preview, "stale");
        Files.write(root.resolve("TEST/A/test-input-user.xml"), before);
        commit(body, preview(body));
        check(read("TEST/A/test-input-user.xml").contains("constValue=\"new\""), "common update");
    }

    private static void testYear() throws Exception {
        Map<String, Object> body = map("operation", "year", "mode", "fixed", "value", "2030");
        commit(body, preview(body));
        check(read("TEST/A/test-input-user.xml").contains("constValue=\"2030\""), "fixed year");
        body = map("operation", "year", "mode", "automatic");
        commit(body, preview(body));
        check(read("TEST/A/test-input-user.xml").contains("$DATE_TIME_NOW_items.Year"), "automatic year");
    }

    private static void testCommonTypes() throws Exception {
        Files.createDirectories(root.resolve("TEST/B"));
        String header = "<t:header><t:constants><t:constant name=\"USER_SERVICE_ID\" constValue=\"001\"/></t:constants><t:parameters/></t:header>";
        write("TEST/B/test-input-user.xml", "<t:testTemplate xmlns:t=\"https://www.w3schools.com\">" + header
                + "<t:testData><t:test><t:id>1</t:id><t:labels>A</t:labels></t:test></t:testData></t:testTemplate>");
        write("TEST/B/test-input-other.xml", "<t:testTemplate xmlns:t=\"https://www.w3schools.com\"><t:header><t:constants/>"
                + "<t:parameters><t:parameter name=\"USER_SERVICE_ID\" type=\"number\" defaultValue=\"2\"/></t:parameters></t:header>"
                + "<t:testData><t:test><t:id>1</t:id><t:labels>A</t:labels>"
                + "<t:parameter name=\"USER_SERVICE_ID\" paramValue=\"$RAW_EXPRESSION\"/></t:test></t:testData></t:testTemplate>");
        String first = "<test name=\"user\"><parameter name=\"xmlTemplateFile\" value=\"TEST/B/test-input-user.xml\"/></test>";
        String second = "<test name=\"other\"><parameter name=\"xmlTemplateFile\" value=\"TEST/B/test-input-other.xml\"/></test>";
        write("TEST/B/suite-main.xml", "<suite name=\"main\">" + first + second + "</suite>");
        write("TEST/B/suite-shared.xml", "<suite name=\"shared\">" + second + "</suite>");
        Method common = ChargingTestConsole.class.getDeclaredMethod("commonModel", String.class);
        common.setAccessible(true);
        Map<?, ?> model = (Map<?, ?>) common.invoke(console, "TEST/B/suite-main.xml");
        Map<?, ?> property = (Map<?, ?>) ((List<?>) model.get("properties")).get(0);
        List<?> files = (List<?>) property.get("files");
        check(files.size() == 2, "constant and declaration both discovered");
        check(((Map<?, ?>) files.get(0)).get("declaredType") == null, "constant has no XML type");
        check("number".equals(((Map<?, ?>) files.get(1)).get("declaredType")), "parameter XML type");
        Map<String, Object> initialType = map("operation", "type", "sourcePath", "TEST/B/test-input-user.xml",
                "name", "USER_SERVICE_ID", "editorType", "string");
        commit(initialType, preview(initialType));
        model = (Map<?, ?>) common.invoke(console, "TEST/B/suite-main.xml");
        property = (Map<?, ?>) ((List<?>) model.get("properties")).get(0);
        check(Boolean.TRUE.equals(property.get("mixedType")) && property.get("editorType") == null,
                "mixed editor types are not silently selected");
        Map<String, Object> body = map("operation", "common-type", "suitePath", "TEST/B/suite-main.xml",
                "name", "USER_SERVICE_ID", "editorType", "number");
        String beforeUser = read("TEST/B/test-input-user.xml");
        String beforeOther = read("TEST/B/test-input-other.xml");
        String beforeMetadata = read("app/config-metadata.json");
        try { preview(body); throw new AssertionError("lossy number accepted"); }
        catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("Incompatible"), "lossy conversion rejected"); }
        check(beforeUser.equals(read("TEST/B/test-input-user.xml")) && beforeOther.equals(read("TEST/B/test-input-other.xml"))
                && beforeMetadata.equals(read("app/config-metadata.json")), "failed preview writes nothing");
        write("TEST/B/test-input-user.xml", beforeUser.replace("constValue=\"001\"", "constValue=\"1\""));
        write("TEST/B/test-input-other.xml", beforeOther.replace("$RAW_EXPRESSION", "not-a-number"));
        try { preview(body); throw new AssertionError("incompatible scenario accepted"); }
        catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("Incompatible"), "scenario validated"); }
        write("TEST/B/test-input-user.xml", beforeUser);
        write("TEST/B/test-input-other.xml", beforeOther);
        body.put("value", "3");
        try { preview(body); throw new AssertionError("expression replacement accepted"); }
        catch (InvocationTargetException ex) {
            check(ex.getCause().getMessage().contains("Parameterized"), "common replacement protects expressions");
        }
        check(read("TEST/B/test-input-other.xml").equals(beforeOther), "protected preview does not write");
        write("TEST/B/test-input-other.xml", beforeOther.replace("$RAW_EXPRESSION", "2"));
        beforeOther = read("TEST/B/test-input-other.xml");
        Map<String, Object> p = preview(body);
        check(((List<?>) p.get("impact")).size() == 3, "all shared referencing tests included");
        check(((List<?>) ((Map<?, ?>) p.get("data")).get("values")).size() == 3, "all replacement values previewed");
        write("TEST/B/test-input-other.xml", beforeOther + "\n");
        expectFailure(body, p, "stale");
        check(beforeUser.equals(read("TEST/B/test-input-user.xml")) && beforeMetadata.equals(read("app/config-metadata.json")),
                "stale commit writes nothing");
        write("TEST/B/test-input-other.xml", beforeOther);
        commit(body, preview(body));
        check(read("TEST/B/test-input-user.xml").contains("constValue=\"3\""), "replacement constant");
        check(read("TEST/B/test-input-other.xml").contains("defaultValue=\"3\"")
                && read("TEST/B/test-input-other.xml").contains("paramValue=\"3\""), "replacement default and scenario");
        body.remove("value");
        body.put("editorType", "unixTimestamp");
        write("TEST/B/test-input-other.xml", read("TEST/B/test-input-other.xml").replace("paramValue=\"3\"", "paramValue=\"$RAW_EXPRESSION\""));
        p = preview(body);
        check(!((List<?>) p.get("warnings")).isEmpty(), "expression produces warning");
        commit(body, p);
        check(read("TEST/B/test-input-other.xml").contains("paramValue=\"$RAW_EXPRESSION\""), "type-only preserves expression");
        model = (Map<?, ?>) common.invoke(console, "TEST/B/suite-main.xml");
        property = (Map<?, ?>) ((List<?>) model.get("properties")).get(0);
        check(Boolean.FALSE.equals(property.get("mixedType")) && "unixTimestamp".equals(property.get("editorType")),
                "common metadata applied across files");
        check(read("TEST/B/test-input-other.xml").contains("type=\"number\""), "timestamp uses schema-compatible number");
    }

    private static void testDisplayResolution() throws Exception {
        Files.createDirectories(root.resolve("TEST/C"));
        String input = "<t:testTemplate xmlns:t=\"https://www.w3schools.com\"><t:header><t:constants>"
                + "<t:constant name=\"BASE\" constValue=\"actual\"/>"
                + "<t:constant name=\"CHAIN\" constValue=\"${BASE}\"/>"
                + "<t:constant name=\"CYCLE_A\" constValue=\"${CYCLE_B}\"/>"
                + "<t:constant name=\"CYCLE_B\" constValue=\"${CYCLE_A}\"/>"
                + "<t:constant name=\"CURRENT_YEAR\" constValue=\"$DATE_TIME_NOW_items.Year\"/>"
                + "</t:constants><t:parameters><t:parameter name=\"chosen\" type=\"string\" defaultValue=\"fallback\"/>"
                + "<t:parameter name=\"observed\" type=\"string\"/><t:parameter name=\"fake\" type=\"string\"/>"
                + "<t:parameter name=\"observedYear\" type=\"string\"/><t:parameter name=\"observedChain\" type=\"string\"/>"
                + "<t:parameter name=\"unchangedPath\" type=\"string\"/><t:parameter name=\"bracedPath\" type=\"string\"/>"
                + "<t:parameter name=\"testExtension\" type=\"string\"/></t:parameters></t:header><t:testData>"
                + "<t:test><t:id>1</t:id><t:labels>C</t:labels>"
                + "<t:parameter name=\"chosen\" paramValue=\"${BASE}\"/>"
                + "<t:parameter name=\"observed\" paramValue=\"prefix-${BASE}\"/>"
                + "<t:parameter name=\"fake\" paramValue=\"${chosen}\"/>"
                + "<t:parameter name=\"observedYear\" paramValue=\"${CURRENT_YEAR}-06-19T10:26:46\"/>"
                + "<t:parameter name=\"observedChain\" paramValue=\"${CHAIN}\"/>"
                + "<t:parameter name=\"unchangedPath\" paramValue=\"$_TEST_DIR/templates/${BASE}.xml\"/>"
                + "<t:parameter name=\"bracedPath\" paramValue=\"${_TEST_DIR}/templates/${BASE}.xml\"/>"
                + "<t:parameter name=\"testExtension\" paramValue=\"TEST/C/validation.xml\"/></t:test>"
                + "<t:test><t:id>2</t:id><t:labels>C</t:labels>"
                + "<t:parameter name=\"testExtension\" paramValue=\"TEST/C/validation.xml\"/></t:test>"
                + "</t:testData></t:testTemplate>";
        String validation = "<validation><x>${chosen}</x><year>${CURRENT_YEAR}</year>"
                + "<chain>${CHAIN}</chain><cycle>${CYCLE_A}</cycle><missing>${MISSING}</missing></validation>";
        write("TEST/C/test-input-user.xml", input);
        write("TEST/C/validation.xml", validation);
        write("TEST/C/suite-main.xml", "<suite name=\"C\"><test name=\"C\">"
                + "<parameter name=\"xmlTemplateFile\" value=\"TEST/C/test-input-user.xml\"/>"
                + "<parameter name=\"testFilterLabel\" value=\"C\"/></test></suite>");
        Method method = ChargingTestConsole.class.getDeclaredMethod("scenarios", String.class, String.class, boolean.class);
        method.setAccessible(true);
        List<?> scenarios = (List<?>) method.invoke(console, "TEST/C/test-input-user.xml", "C", false);
        Map<?, ?> first = (Map<?, ?>) scenarios.get(0), second = (Map<?, ?>) scenarios.get(1);
        Map<?, ?> observed = findField((List<?>) first.get("fields"), "observed");
        Map<?, ?> observedDisplay = (Map<?, ?>) observed.get("display");
        check("prefix-actual".equals(observedDisplay.get("value")), "input constant interpolation");
        check("${chosen}".equals(findField((List<?>) first.get("fields"), "fake").get("value")), "raw parameter remains intact");
        check("unresolved".equals(display(findField((List<?>) first.get("fields"), "fake")).get("status")),
                "scenario parameters are not input Velocity variables");
        Map<?, ?> yearPreview = display(findField((List<?>) first.get("fields"), "observedYear"));
        check("preview".equals(yearPreview.get("status")), "automatic year input preview");
        check(((String) yearPreview.get("value")).endsWith("-06-19T10:26:46"), "embedded year preserved");
        check(yearPreview.get("zone") != null && yearPreview.get("evaluatedAt") != null, "preview clock metadata");
        check(((String) yearPreview.get("reason")).contains("one pass"), "preview explains runner limitation");
        Map<?, ?> yearSource = (Map<?, ?>) ((List<?>) yearPreview.get("sources")).get(0);
        check(Boolean.TRUE.equals(yearSource.get("globalYear")) && Boolean.FALSE.equals(yearSource.get("editable")), "global year source");
        Map<?, ?> chainPreview = display(findField((List<?>) first.get("fields"), "observedChain"));
        check("preview".equals(chainPreview.get("status")) && "actual".equals(chainPreview.get("value")), "constant chain preview");
        check(((List<?>) chainPreview.get("sources")).size() == 2, "constant chain provenance");
        Method timed = ChargingTestConsole.class.getDeclaredMethod("scenarios", String.class, String.class,
                boolean.class, java.time.Instant.class);
        timed.setAccessible(true);
        java.time.Instant boundary = java.time.Instant.parse("2030-12-31T23:30:00Z");
        List<?> timedScenarios = (List<?>) timed.invoke(console, "TEST/C/test-input-user.xml", "C", false, boundary);
        Map<?, ?> timedScenario = (Map<?, ?>) timedScenarios.get(0);
        Map<?, ?> timedYear = display(findField((List<?>) timedScenario.get("fields"), "observedYear"));
        String expectedYear = Integer.toString(boundary.atZone(java.time.ZoneId.systemDefault()).getYear());
        check((expectedYear + "-06-19T10:26:46").equals(timedYear.get("value")), "preview uses supplied clock and zone");
        check(boundary.toString().equals(timedYear.get("evaluatedAt")), "preview retains evaluation instant");
        check(timedYear.get("evaluatedAt").equals(display((Map<?, ?>) validationFields(timedScenario).get("year")).get("evaluatedAt")),
                "input and validation previews use one instant");
        for (String pathField : Arrays.asList("unchangedPath", "bracedPath")) {
            Map<?, ?> pathValue = findField((List<?>) first.get("fields"), pathField);
            check("raw".equals(display(pathValue).get("status")), "_TEST_DIR path not resolved");
            check(pathValue.get("value").equals(display(pathValue).get("value")), "entire path shown unchanged");
            check(((List<?>) display(pathValue).get("sources")).isEmpty(), "path references not traversed");
        }
        Map<?, ?> firstValidation = validationFields(first), secondValidation = validationFields(second);
        check("actual".equals(display((Map<?, ?>) firstValidation.get("x")).get("value")), "scenario override in validation context");
        check("fallback".equals(display((Map<?, ?>) secondValidation.get("x")).get("value")), "scenario default in validation context");
        check("actual".equals(display((Map<?, ?>) firstValidation.get("chain")).get("value")), "constant chain across template stages");
        check("preview".equals(display((Map<?, ?>) firstValidation.get("year")).get("status")), "automatic year preview");
        check(display((Map<?, ?>) firstValidation.get("year")).get("zone") != null, "preview timezone included");
        check("unresolved".equals(display((Map<?, ?>) firstValidation.get("cycle")).get("status")), "cycle diagnosed");
        check("unresolved".equals(display((Map<?, ?>) firstValidation.get("missing")).get("status")), "missing reference diagnosed");
        check(input.equals(read("TEST/C/test-input-user.xml")) && validation.equals(read("TEST/C/validation.xml")),
                "model reads never write fixtures");
        Map<?, ?> source = (Map<?, ?>) ((List<?>) observedDisplay.get("sources")).get(0);
        check(Boolean.TRUE.equals(source.get("editable")) && "BASE".equals(source.get("name")), "editable literal source identified");
        fieldUpdate(source, "changed", (String) source.get("revision"));
        check(read("TEST/C/test-input-user.xml").contains("paramValue=\"prefix-${BASE}\""), "source edit preserves expression");
        try { fieldUpdate(source, "stale", (String) source.get("revision")); throw new AssertionError("stale source accepted"); }
        catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("reload"), "stale source rejected"); }
        scenarios = (List<?>) method.invoke(console, "TEST/C/test-input-user.xml", "C", false);
        first = (Map<?, ?>) scenarios.get(0);
        observed = findField((List<?>) first.get("fields"), "observed");
        try { fieldUpdate(observed, "prefix-changed", (String) observed.get("revision")); throw new AssertionError("expression overwrite accepted"); }
        catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("Parameterized"), "structured replacement blocked"); }
        try { fieldUpdate(observed, "prefix-changed", (String) observed.get("revision"), true); throw new AssertionError("literal replacement accepted"); }
        catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("retain an XML expression"), "explicit editor still protects against saving previews"); }
        try { fieldUpdate(observed, "updated-${BASE}", null, true); throw new AssertionError("unversioned expression edit accepted"); }
        catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("Revision"), "expression editing requires a revision"); }
        String expressionRevision = (String) observed.get("revision");
        fieldUpdate(observed, "updated-${BASE}", expressionRevision, true);
        check(read("TEST/C/test-input-user.xml").contains("paramValue=\"updated-${BASE}\""), "explicit XML expression edit saved");
        check(read("TEST/C/test-input-user.xml").contains("constValue=\"changed\""), "editing expression does not change source constant");
        try { fieldUpdate(observed, "stale-${BASE}", expressionRevision, true); throw new AssertionError("stale expression edit accepted"); }
        catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("reload"), "stale expression edit rejected"); }
        write("TEST/C/test-input-user.xml", read("TEST/C/test-input-user.xml").replace("$DATE_TIME_NOW_items.Year", "2030"));
        scenarios = (List<?>) method.invoke(console, "TEST/C/test-input-user.xml", "C", false);
        firstValidation = validationFields((Map<?, ?>) scenarios.get(0));
        check("2030".equals(display((Map<?, ?>) firstValidation.get("year")).get("value")), "fixed year resolves");
        Map<?, ?> fixedInput = display(findField((List<?>) ((Map<?, ?>) scenarios.get(0)).get("fields"), "observedYear"));
        check("resolved".equals(fixedInput.get("status")) && "2030-06-19T10:26:46".equals(fixedInput.get("value")), "fixed input year");
        Method common = ChargingTestConsole.class.getDeclaredMethod("commonModel", String.class);
        common.setAccessible(true);
        Map<?, ?> commonModel = (Map<?, ?>) common.invoke(console, "TEST/C/suite-main.xml");
        for (Object item : (List<?>) commonModel.get("properties")) {
            Map<?, ?> property = (Map<?, ?>) item;
            if ("CHAIN".equals(property.get("name"))) {
                Map<?, ?> group = (Map<?, ?>) ((List<?>) property.get("values")).get(0);
                check(display(group).get("status") != null, "common value display exists");
                Map<?, ?> file = (Map<?, ?>) ((List<?>) property.get("files")).get(0);
                check("constValue".equals(file.get("attribute")) && file.get("nodePath") != null
                        && file.get("sourcePath").equals(file.get("path")), "common entry has exact expression-edit identity");
                Map<String, Object> replace = map("operation", "common", "suitePath", "TEST/C/suite-main.xml",
                        "name", "CHAIN", "value", "literal");
                try { preview(replace); throw new AssertionError("common expression replacement accepted"); }
                catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("Parameterized"), "common expression protected"); }
            }
        }
    }

    private static Map<?, ?> findField(List<?> fields, String name) {
        for (Object item : fields) if (name.equals(((Map<?, ?>) item).get("label"))) return (Map<?, ?>) item;
        throw new AssertionError("Missing field: " + name);
    }

    private static Map<?, ?> display(Map<?, ?> field) { return (Map<?, ?>) field.get("display"); }

    private static Map<?, ?> validationFields(Map<?, ?> scenario) {
        Map<?, ?> validation = (Map<?, ?>) ((List<?>) scenario.get("validations")).get(0);
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (Object group : (List<?>) validation.get("groups")) {
            for (Object item : (List<?>) ((Map<?, ?>) group).get("fields")) {
                Map<?, ?> field = (Map<?, ?>) item;
                result.put((String) field.get("label"), field);
            }
        }
        return result;
    }

    private static void fieldUpdate(Map<?, ?> source, String value, String revision) throws Exception {
        fieldUpdate(source, value, revision, false);
    }

    private static void fieldUpdate(Map<?, ?> source, String value, String revision, boolean editExpression) throws Exception {
        Map<String, Object> body = map("sourcePath", source.get("sourcePath"), "nodePath", source.get("nodePath"),
                "attribute", source.get("attribute"), "value", value);
        if (revision != null) body.put("revision", revision);
        if (editExpression) body.put("editExpression", Boolean.TRUE);
        Class<?> json = Class.forName("ChargingTestConsole$Json");
        Method write = json.getDeclaredMethod("write", Object.class); write.setAccessible(true);
        String request = (String) write.invoke(null, body);
        Method update = ChargingTestConsole.class.getDeclaredMethod("updateField", com.sun.net.httpserver.HttpExchange.class);
        update.setAccessible(true); update.invoke(console, new TestExchange(request));
    }

    private static final class TestExchange extends com.sun.net.httpserver.HttpExchange {
        private final java.io.InputStream body;
        TestExchange(String json) { body = new java.io.ByteArrayInputStream(json.getBytes(StandardCharsets.UTF_8)); }
        public java.io.InputStream getRequestBody() { return body; }
        public com.sun.net.httpserver.Headers getRequestHeaders() { return new com.sun.net.httpserver.Headers(); }
        public com.sun.net.httpserver.Headers getResponseHeaders() { return new com.sun.net.httpserver.Headers(); }
        public java.net.URI getRequestURI() { return java.net.URI.create("/api/field"); }
        public String getRequestMethod() { return "POST"; }
        public com.sun.net.httpserver.HttpContext getHttpContext() { return null; }
        public void close() { }
        public java.io.OutputStream getResponseBody() { return new java.io.ByteArrayOutputStream(); }
        public void sendResponseHeaders(int code, long length) { }
        public java.net.InetSocketAddress getRemoteAddress() { return null; }
        public int getResponseCode() { return 200; }
        public java.net.InetSocketAddress getLocalAddress() { return null; }
        public String getProtocol() { return "HTTP/1.1"; }
        public Object getAttribute(String name) { return null; }
        public void setAttribute(String name, Object value) { }
        public void setStreams(java.io.InputStream input, java.io.OutputStream output) { }
        public com.sun.net.httpserver.HttpPrincipal getPrincipal() { return null; }
    }

    private static void testLabelsAndType() throws Exception {
        Map<String, Object> labels = map("operation", "labels", "suitePath", "TEST/A/suite-main.xml",
                "testNodePath", "0/0", "labels", Arrays.asList("A", "B"));
        Map<String, Object> preview = preview(labels);
        Map<?, ?> data = (Map<?, ?>) preview.get("data");
        check(Integer.valueOf(1).equals(data.get("scenarioCount")), "ID filter applied");
        commit(labels, preview);
        String suite = read("TEST/A/suite-main.xml");
        check(suite.contains("__APP_UNION_") && suite.contains(":id|1|"), "union retains ID filter");
        String input = read("TEST/A/test-input-user.xml");
        check(input.contains("A,B,__APP_UNION_") && input.contains("B,__APP_UNION_"), "union matches each selected scenario");
        Map<String, Object> type = map("operation", "type", "sourcePath", "TEST/A/test-input-user.xml",
                "name", "amount", "editorType", "number");
        try { preview(type); throw new AssertionError("incompatible value accepted"); }
        catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("Incompatible"), "type validation"); }
        write("TEST/A/test-input-user.xml", input.replace("paramValue=\"oops\"", "paramValue=\"3\""));
        commit(type, preview(type));
        check(read("TEST/A/test-input-user.xml").contains("type=\"number\""), "declared type update");
    }

    private static void testCreation() throws Exception {
        String originalInput = read("TEST/A/test-input-user.xml");
        String originalValidation = read("TEST/A/validation.xml");
        Map<String, Object> create = map("operation", "create", "suitePath", "TEST/A/suite-main.xml",
                "sourceTestNodePath", "0/0", "name", "new test", "kind", "guided", "position", "after");
        Map<String, Object> p = preview(create);
        Map<?, ?> data = (Map<?, ?>) p.get("data");
        check(((List<?>) data.get("newValidationPaths")).size() == 1, "validation copy preview");
        commit(create, p);
        String newInput = (String) data.get("newInputPath");
        check(Files.exists(root.resolve(newInput)), "new input exists");
        check(read(newInput).contains("validation-new-test.xml"), "validation reference rewritten");
        check(read("TEST/A/test-input-user.xml").equals(originalInput), "original input unchanged");
        check(read("TEST/A/validation.xml").equals(originalValidation), "original validation unchanged");
        String metadata = read("app/config-metadata.json");
        check(metadata.contains("test-input-user-new-test.xml:amount"), "metadata copied");
    }

    private static void testStagingFailure() throws Exception {
        Class<?> type = Class.forName("ChargingTestConsole$ChangeSet");
        Constructor<?> constructor = type.getDeclaredConstructor(ChargingTestConsole.class);
        constructor.setAccessible(true);
        Object changes = constructor.newInstance(console);
        Method bytes = type.getDeclaredMethod("bytes", Path.class, byte[].class);
        Method revisions = type.getDeclaredMethod("revisions");
        Method commit = type.getDeclaredMethod("commit", Map.class);
        bytes.setAccessible(true); revisions.setAccessible(true); commit.setAccessible(true);
        Path original = root.resolve("TEST/A/validation.xml");
        String old = read("TEST/A/validation.xml");
        bytes.invoke(changes, original, "modified".getBytes(StandardCharsets.UTF_8));
        bytes.invoke(changes, root.resolve("TEST/A/missing/new.xml"), "new".getBytes(StandardCharsets.UTF_8));
        try {
            commit.invoke(changes, revisions.invoke(changes));
            throw new AssertionError("staging failure expected");
        } catch (InvocationTargetException expected) {
            check(read("TEST/A/validation.xml").equals(old), "staging failure leaves original unchanged");
            try (java.util.stream.Stream<Path> files = Files.list(original.getParent())) {
                check(!files.anyMatch(p -> p.getFileName().toString().endsWith(".tmp")), "staging cleanup");
            }
        }
    }

    private static void testSessionIndependence() throws Exception {
                String header = "<t:header><t:constants><t:constant name=\"_TEST_DIR\" constValue=\"TEST/A\"/></t:constants>"
                        + "<t:parameters><t:parameter name=\"sessionDefinitionFileList\" type=\"string\"/>"
                        + "<t:parameter name=\"testExtension\" type=\"string\"/></t:parameters></t:header>";
                String scenarios = "<t:testData><t:test><t:id>1</t:id><t:labels>SESSION</t:labels>"
                        + "<t:parameter name=\"sessionDefinitionFileList\" paramValue=\"${_TEST_DIR}/one.ini,${_TEST_DIR}/two.ini\"/>"
                        + "<t:parameter name=\"testExtension\" paramValue=\"$_TEST_DIR/validation.xml\"/></t:test></t:testData>";
                write("TEST/A/test-input-session.xml", "<t:testTemplate xmlns:t=\"https://www.w3schools.com\">" + header + scenarios + "</t:testTemplate>");
                String ini1 = "[DEFINITION]\r\nid=one\r\n[EXTENSION]\r\n# testExtension=ignored.xml\r\n"
                        + "testExtension=${TEST_INPUT/_TEST_DIR}/validation.xml\r\n[DEFAULTS]\r\n@defaults_file=shared.ini\r\n";
                String ini2 = "[DEFINITION]\nid=two\n[EXTENSION]\ntestExtension=${TEST_INPUT/_TEST_DIR}/nested.xml\n";
                write("TEST/A/one.ini", ini1); write("TEST/A/two.ini", ini2);
                write("TEST/A/nested.xml", "<validation><value>nested original</value></validation>");
                write("TEST/A/suite-session.xml", "<suite name=\"session\"><test name=\"source\">"
                        + "<parameter name=\"xmlTemplateFile\" value=\"TEST/A/test-input-session.xml\"/>"
                        + "<parameter name=\"testFilterLabel\" value=\"SESSION\"/><classes><class name=\"Example\"><methods>"
                        + "<include name=\"t900_execute_charging_session\"/></methods></class></classes></test></suite>");
                Map<String, Object> body = map("operation", "create", "suitePath", "TEST/A/suite-session.xml",
                        "sourceTestNodePath", "0/0", "name", "session copy", "kind", "duplicate", "position", "after");
                Map<String, Object> p = preview(body);
                Map<?, ?> data = (Map<?, ?>) p.get("data");
                List<?> sessions = (List<?>) data.get("newSessionPaths");
                List<?> validations = (List<?>) data.get("newValidationPaths");
                check(sessions.size() == 2 && validations.size() == 2, "session and deduplicated validation preview");
                write("TEST/A/one.ini", ini1 + "# concurrent\n");
                expectFailure(body, p, "stale");
                write("TEST/A/one.ini", ini1);
                p = preview(body); data = (Map<?, ?>) p.get("data");
                sessions = (List<?>) data.get("newSessionPaths"); validations = (List<?>) data.get("newValidationPaths");
                commit(body, p);
                String copiedInput = read((String) data.get("newInputPath"));
                check(copiedInput.contains("one-session-copy.ini") && copiedInput.contains("two-session-copy.ini"), "session list rewritten");
                String firstCopy = read((String) sessions.get(0));
                check(firstCopy.contains("# testExtension=ignored.xml\r\n") && firstCopy.contains("@defaults_file=shared.ini\r\n"), "session lines preserved");
                check(firstCopy.contains("testExtension=TEST/A/validation-session-copy.xml"), "nested reference rewritten");
                check(read("TEST/A/one.ini").equals(ini1) && read("TEST/A/two.ini").equals(ini2), "source sessions unchanged");
                String nestedCopy = (String) validations.get(1);
                write(nestedCopy, "<validation><value>edited copy</value></validation>");
                check(read("TEST/A/nested.xml").contains("nested original"), "nested validation independent");
                Method scenariosMethod = ChargingTestConsole.class.getDeclaredMethod("scenarios", String.class, String.class, boolean.class);
                scenariosMethod.setAccessible(true);
                List<?> shown = (List<?>) scenariosMethod.invoke(console, data.get("newInputPath"), "SESSION", false);
                Map<?, ?> scenario = (Map<?, ?>) shown.get(0);
                check(((List<?>) scenario.get("validations")).size() == 2, "nested validation surfaced in model");
                write("TEST/A/one.ini", ini1.replace("${TEST_INPUT/_TEST_DIR}", "${TEST_INPUT/MISSING}"));
                body.put("name", "another session");
                try { preview(body); throw new AssertionError("unresolved session validation accepted"); }
                catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("Unresolved"), "unresolved session blocked"); }
                write("TEST/A/one.ini", "[EXTENSION]\ntestExtension=${TEST_INPUT/_TEST_DIR}/${TEST_INPUT/ext}\n");
                String ambiguous = "<t:testTemplate xmlns:t=\"https://www.w3schools.com\"><t:header>"
                        + "<t:constants><t:constant name=\"_TEST_DIR\" constValue=\"TEST/A\"/></t:constants>"
                        + "<t:parameters><t:parameter name=\"sessionDefinitionFileList\" type=\"string\" defaultValue=\"${_TEST_DIR}/one.ini\"/>"
                        + "<t:parameter name=\"ext\" type=\"string\" defaultValue=\"validation.xml\"/></t:parameters></t:header>"
                        + "<t:testData><t:test><t:id>1</t:id><t:labels>SESSION</t:labels></t:test>"
                        + "<t:test><t:id>2</t:id><t:labels>SESSION</t:labels><t:parameter name=\"ext\" paramValue=\"nested.xml\"/>"
                        + "</t:test></t:testData></t:testTemplate>";
                write("TEST/A/test-input-ambiguous.xml", ambiguous);
                write("TEST/A/suite-ambiguous.xml", "<suite><test name=\"source\"><parameter name=\"xmlTemplateFile\""
                        + " value=\"TEST/A/test-input-ambiguous.xml\"/><parameter name=\"testFilterLabel\" value=\"SESSION\"/>"
                        + "<classes><class name=\"Example\"><methods><include name=\"t900_execute_charging_session\"/>"
                        + "</methods></class></classes></test></suite>");
                body.put("suitePath", "TEST/A/suite-ambiguous.xml");
                try { preview(body); throw new AssertionError("scenario-dependent validation accepted"); }
                catch (InvocationTargetException ex) { check(ex.getCause().getMessage().contains("differs"), "ambiguous session blocked"); }
    }

    private static void testCommitRollback() throws Exception {
        Class<?> type = Class.forName("ChargingTestConsole$ChangeSet");
        Constructor<?> constructor = type.getDeclaredConstructor(ChargingTestConsole.class);
        constructor.setAccessible(true);
        Object changes = constructor.newInstance(console);
        Method bytes = type.getDeclaredMethod("bytes", Path.class, byte[].class);
        Method revisions = type.getDeclaredMethod("revisions");
        Method commit = type.getDeclaredMethod("commit", Map.class);
        bytes.setAccessible(true); revisions.setAccessible(true); commit.setAccessible(true);
        Path first = root.resolve("TEST/A/validation.xml"), second = root.resolve("TEST/A/new.xml");
        String old = read("TEST/A/validation.xml");
        bytes.invoke(changes, first, "changed".getBytes(StandardCharsets.UTF_8));
        bytes.invoke(changes, second, "new".getBytes(StandardCharsets.UTF_8));
        Object expected = revisions.invoke(changes);
        final String deniedPath = second.toString();
        SecurityManager previous = System.getSecurityManager();
        SecurityManager failSecondMove = new SecurityManager() {
            private boolean denied;
            @Override public void checkPermission(java.security.Permission permission) { }
            @Override public void checkWrite(String path) {
                if (!denied && deniedPath.equals(path)) { denied = true; throw new SecurityException("injected move failure"); }
            }
        };
        try {
            System.setSecurityManager(failSecondMove);
            try {
                commit.invoke(changes, expected);
                throw new AssertionError("commit failure expected");
            } catch (InvocationTargetException ex) {
                check(ex.getCause().getMessage().contains("injected move failure"), "injected failure reached commit");
            }
        } finally { System.setSecurityManager(previous); }
        check(read("TEST/A/validation.xml").equals(old), "mid-commit rollback restored original");
        check(!Files.exists(second), "mid-commit rollback left no new file");
        try (java.util.stream.Stream<Path> files = Files.list(first.getParent())) {
            check(!files.anyMatch(p -> p.getFileName().toString().endsWith(".tmp")), "rollback cleaned staged files");
        }
    }

    private static void testSupportedKinds() throws Exception {
        String[] methods = { "t990_execute_action", "t930_execute_charge", "t920_execute_soap_request",
                "t999_cleanup_delete_subscriber_from_cc", "t900_execute_charging_session", "t500_execute_acquire" };
        StringBuilder xml = new StringBuilder("<suite name=\"examples\">");
        for (int i = 0; i < methods.length; i++) {
            xml.append("<test name=\"source").append(i).append("\">")
                    .append("<parameter name=\"xmlTemplateFile\" value=\"TEST/A/test-input-user.xml\"/>")
                    .append("<parameter name=\"testFilterLabel\" value=\"A\"/>")
                    .append("<classes><class name=\"Example\"><methods><include name=\"").append(methods[i])
                    .append("\"/></methods></class></classes></test>");
        }
        xml.append("</suite>");
        write("TEST/A/suite-examples.xml", xml.toString());
        for (int i = 0; i < methods.length; i++) {
            Map<String, Object> body = map("operation", "create", "suitePath", "TEST/A/suite-examples.xml",
                    "sourceTestNodePath", "0/" + i, "name", "guided " + i,
                    "kind", "guided", "position", "beforeCleanup");
            check(((List<?>) preview(body).get("changes")).size() >= 3, "guided " + methods[i]);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> preview(Map<String, Object> body) throws Exception {
        return (Map<String, Object>) mutation.invoke(console, body, false);
    }
    private static void commit(Map<String, Object> body, Map<String, Object> preview) throws Exception {
        Map<String, Object> copy = new LinkedHashMap<String, Object>(body);
        copy.put("revisions", preview.get("revisions")); mutation.invoke(console, copy, true);
    }
    private static void expectFailure(Map<String, Object> body, Map<String, Object> preview, String text) throws Exception {
        try { commit(body, preview); throw new AssertionError("expected failure"); }
        catch (InvocationTargetException ex) { check(ex.getCause().getMessage().toLowerCase().contains(text), "failure message"); }
    }
    private static Map<String, Object> map(Object... args) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (int i = 0; i < args.length; i += 2) result.put((String) args[i], args[i + 1]);
        return result;
    }
    private static void write(String path, String content) throws Exception {
        Files.write(root.resolve(path), content.getBytes(StandardCharsets.UTF_8));
    }
    private static String read(String path) throws Exception {
        return new String(Files.readAllBytes(root.resolve(path)), StandardCharsets.UTF_8);
    }
    private static byte[] concat(byte[] a, byte[] b) {
        byte[] result = Arrays.copyOf(a, a.length + b.length); System.arraycopy(b, 0, result, a.length, b.length); return result;
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
