import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.validation.SchemaFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.Transformer;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.io.StringReader;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.math.BigDecimal;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.time.LocalDateTime;
import java.time.Year;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.Set;
import java.util.LinkedHashSet;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.w3c.dom.Attr;
import org.w3c.dom.Document;
import org.w3c.dom.DocumentType;
import org.w3c.dom.Element;
import org.w3c.dom.NamedNodeMap;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

public final class ChargingTestConsole {
    private static final Charset UTF8 = StandardCharsets.UTF_8;
    private static final int PORT = 8765;
    private static final int MAX_REQUEST_BYTES = 16 * 1024 * 1024;
    private static final int LOG_TAIL_BYTES = 64 * 1024;
    private static final String DEFAULT_TARGET_ENVIRONMENT = "Default";

    private final Path root;
    private final Path testRoot;
    private final Path testFile;
    private final Path webRoot;
    private final Path reportsRoot;
    private final Path landscapeConfig;
    private final List<Environment> environments;
    private final Object runLock = new Object();
    private final Object xmlWriteLock = new Object();
    private final Object environmentWriteLock = new Object();
    private volatile String selectedEnvironment;
    private volatile RunState runState = new RunState();
    private HttpServer server;
    private ExecutorService executor;

    private ChargingTestConsole(Path root) throws IOException {
        this.root = root.toRealPath();
        this.testRoot = requireDirectory(this.root.resolve("TEST"));
        this.testFile = requireFile(this.root.resolve("test.xml"));
        this.webRoot = requireDirectory(this.root.resolve(Paths.get("app", "web")));
        this.reportsRoot = this.root.resolve(Paths.get("target", "antrun", "logs")).normalize();
        this.landscapeConfig = this.root.resolve(Paths.get(
                "install-package-sap-cc-unit-testing-framework-0.8.3", "config", "config.properties"));
        if (!Files.isRegularFile(this.landscapeConfig)) {
            throw new IOException("Environment selection file not found: " + this.landscapeConfig);
        }
        this.environments = loadEnvironments();
        this.selectedEnvironment = readSelectedEnvironment();
    }

    public static void main(String[] args) throws Exception {
        Path root = args.length == 0 ? inferRoot(Paths.get("").toAbsolutePath()) : Paths.get(args[0]);
        final ChargingTestConsole application = new ChargingTestConsole(root);
        application.start();
        System.out.println("READY http://127.0.0.1:" + PORT);
    }

    private void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", PORT), 0);
        executor = Executors.newCachedThreadPool();
        server.setExecutor(executor);
        server.createContext("/api/state", api("GET", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return state(); }
        }));
        server.createContext("/api/environment", api("POST", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return changeEnvironment(exchange); }
        }));
        server.createContext("/api/target/environment", api("POST", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return changeTargetEnvironment(exchange); }
        }));
        server.createContext("/api/target", api("POST", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return createTarget(exchange); }
        }));
        server.createContext("/api/file", new SafeHandler() {
            protected void handleSafely(HttpExchange exchange) throws Exception { handleFile(exchange); }
        });
        server.createContext("/api/suite/model", api("GET", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return suiteModel(exchange); }
        }));
        server.createContext("/api/field", api("POST", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return updateField(exchange); }
        }));
        server.createContext("/api/config/year", api("GET", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return yearModel(); }
        }));
        server.createContext("/api/config/common", api("GET", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception {
                return commonModel(queryParameters(exchange.getRequestURI()).get("suitePath"));
            }
        }));
        server.createContext("/api/config/preview", api("POST", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return configMutation(readObject(exchange), false); }
        }));
        server.createContext("/api/config/commit", api("POST", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return configMutation(readObject(exchange), true); }
        }));
        server.createContext("/api/timestamp", api("POST", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception {
                Map<String, Object> body = readObject(exchange);
                try {
                    if (body.containsKey("epochMillis")) return TimestampSupport.describe(requiredString(body, "epochMillis"));
                    return TimestampSupport.convert(requiredString(body, "localDateTime"),
                            body.containsKey("offset") ? requiredString(body, "offset") : null);
                } catch (IllegalArgumentException ex) { throw new HttpError(400, ex.getMessage()); }
            }
        }));
        server.createContext("/api/run/status", api("GET", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return runStatus(); }
        }));
        server.createContext("/api/run", api("POST", new ApiAction() {
            public Object run(HttpExchange exchange) throws Exception { return startRun(exchange); }
        }));
        server.createContext("/api/report", new SafeHandler() {
            protected void handleSafely(HttpExchange exchange) throws Exception { redirectReport(exchange); }
        });
        server.createContext("/report/", new SafeHandler() {
            protected void handleSafely(HttpExchange exchange) throws Exception { serveReport(exchange); }
        });
        server.createContext("/api/shutdown", new SafeHandler() {
            protected void handleSafely(final HttpExchange exchange) throws Exception {
                requireMethod(exchange, "POST");
                sendJson(exchange, 200, singleton("status", "stopping"));
                new Thread(new Runnable() {
                    public void run() {
                        server.stop(1);
                        executor.shutdown();
                    }
                }, "console-shutdown").start();
            }
        });
        server.createContext("/", new SafeHandler() {
            protected void handleSafely(HttpExchange exchange) throws Exception { serveStatic(exchange); }
        });
        server.start();
    }

    private Object state() throws Exception {
        selectedEnvironment = readSelectedEnvironment();
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("selectedEnvironment", selectedEnvironment);
        List<Object> environmentData = new ArrayList<Object>();
        for (Environment environment : environments) {
            Map<String, Object> item = new LinkedHashMap<String, Object>();
            item.put("name", environment.name);
            item.put("properties", environment.properties);
            environmentData.add(item);
        }
        result.put("environments", environmentData);
        result.put("suites", suites());
        result.put("targets", targetMaps(readRunnableTargets(), selectedEnvironment));
        result.put("availableSuiteFiles", availableSuiteFiles());
        Path report = findReport();
        result.put("reportAvailable", report != null);
        return result;
    }

    private Object changeEnvironment(HttpExchange exchange) throws Exception {
        Map<String, Object> body = readObject(exchange);
        String requested = requiredString(body, "environment");
        requireKnownEnvironment(requested);
        writeSelectedEnvironment(requested);
        selectedEnvironment = requested;
        return singleton("selectedEnvironment", requested);
    }

    private Object changeTargetEnvironment(HttpExchange exchange) throws Exception {
        Map<String, Object> body = readObject(exchange);
        String targetName = requiredString(body, "target");
        String environment = requiredString(body, "environment");
        if (!DEFAULT_TARGET_ENVIRONMENT.equals(environment)) requireKnownEnvironment(environment);
        synchronized (xmlWriteLock) {
            byte[] original = Files.readAllBytes(testFile);
            Document document = parseXml(original);
            TargetDefinition target = findRunnableTarget(document, targetName);
            if (target == null) throw new HttpError(400, "Unknown or non-runnable target");
            Element config = directChild(target.runElement, "config");
            if (DEFAULT_TARGET_ENVIRONMENT.equals(environment)) {
                if (config != null) {
                    for (Element property : directChildren(config, "sysproperty")) {
                        if ("ccLandscape".equals(property.getAttribute("key"))) {
                            config.removeChild(property);
                        }
                    }
                    if (directChildren(config, null).isEmpty()) {
                        target.runElement.removeChild(config);
                    }
                }
                writeXmlAtomically(testFile, document, original);
                Map<String, Object> result = new LinkedHashMap<String, Object>();
                result.put("target", targetName);
                result.put("environment", DEFAULT_TARGET_ENVIRONMENT);
                return result;
            }
            if (config == null) {
                config = document.createElement("config");
                target.runElement.appendChild(config);
            }
            Element landscape = null;
            for (Element property : directChildren(config, "sysproperty")) {
                if ("ccLandscape".equals(property.getAttribute("key"))) {
                    landscape = property;
                    break;
                }
            }
            if (landscape == null) {
                landscape = document.createElement("sysproperty");
                landscape.setAttribute("key", "ccLandscape");
                config.appendChild(landscape);
            }
            landscape.setAttribute("value", landscapeValue(environment));
            writeXmlAtomically(testFile, document, original);
        }
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("target", targetName);
        result.put("environment", environment);
        return result;
    }

    private Object createTarget(HttpExchange exchange) throws Exception {
        Map<String, Object> body = readObject(exchange);
        String name = requiredString(body, "name");
        String description = requiredString(body, "description");
        String environment = requiredString(body, "environment");
        if (!name.matches("[A-Za-z0-9_.-]+")) throw new HttpError(400, "Invalid target name");
        if (!DEFAULT_TARGET_ENVIRONMENT.equals(environment)) requireKnownEnvironment(environment);
        Object suiteValue = body.get("suites");
        if (!(suiteValue instanceof List)) throw new HttpError(400, "Missing or invalid suites");
        List<String> suites = new ArrayList<String>();
        Map<String, Boolean> seen = new LinkedHashMap<String, Boolean>();
        for (Object item : (List<?>) suiteValue) {
            if (!(item instanceof String)) throw new HttpError(400, "Suites must be strings");
            Path file = resolveSuiteXml((String) item);
            String relative = relativePath(file);
            if (seen.put(relative.toLowerCase(Locale.ROOT), Boolean.TRUE) != null) {
                throw new HttpError(400, "Suites must be unique");
            }
            suites.add(relative);
        }
        if (suites.isEmpty()) throw new HttpError(400, "At least one suite is required");

        synchronized (xmlWriteLock) {
            byte[] original = Files.readAllBytes(testFile);
            Document document = parseXml(original);
            Element project = document.getDocumentElement();
            for (Element target : directChildren(project, "target")) {
                if (name.equals(target.getAttribute("name"))) {
                    throw new HttpError(409, "Target already exists");
                }
            }
            Element target = document.createElement("target");
            target.setAttribute("name", name);
            target.setAttribute("description", description);

            Element delete = document.createElement("delete");
            delete.setAttribute("dir", "${testng.report.dir}");
            target.appendChild(delete);

            Element fileset = document.createElement("fileset");
            fileset.setAttribute("id", "suitesToRun");
            fileset.setAttribute("dir", "${basedir}/TEST");
            for (String suite : suites) {
                Element include = document.createElement("include");
                include.setAttribute("name", suite.substring("TEST/".length()));
                fileset.appendChild(include);
            }
            target.appendChild(fileset);

            Element run = document.createElement("runMultipleSuites");
            run.setAttribute("pTestColsoleLoggerLevel", "SEVERE");
            run.setAttribute("pCreateClassSubDirForLogs", "true");
            run.setAttribute("pXmlFilesetRef", "suitesToRun");
            if (!DEFAULT_TARGET_ENVIRONMENT.equals(environment)) {
                Element config = document.createElement("config");
                Element property = document.createElement("sysproperty");
                property.setAttribute("key", "ccLandscape");
                property.setAttribute("value", landscapeValue(environment));
                config.appendChild(property);
                run.appendChild(config);
            }
            target.appendChild(run);
            project.appendChild(target);
            writeXmlAtomically(testFile, document, original);
        }
        TargetDefinition created = findTarget(readRunnableTargets(), name);
        if (created == null) throw new IOException("Created target could not be read");
        return targetMap(created, readSelectedEnvironment());
    }

    private void handleFile(HttpExchange exchange) throws Exception {
        if ("GET".equals(exchange.getRequestMethod())) {
            String relative = queryParameters(exchange.getRequestURI()).get("path");
            if (relative == null || relative.length() == 0) {
                throw new HttpError(400, "Missing path");
            }
            Path file = resolveEditableXml(relative, true);
            Map<String, Object> result = new LinkedHashMap<String, Object>();
            result.put("path", relativePath(file));
            result.put("content", new String(Files.readAllBytes(file), UTF8));
            sendJson(exchange, 200, result);
            return;
        }
        if ("PUT".equals(exchange.getRequestMethod())) {
            Map<String, Object> body = readObject(exchange);
            String relative = requiredString(body, "path");
            String content = requiredString(body, "content");
            Path file = resolveEditableXml(relative, true);
            validateXml(content);
            synchronized (xmlWriteLock) {
                Path temporary = file.resolveSibling("." + file.getFileName() + "." + UUID.randomUUID() + ".tmp");
                try {
                    Files.write(temporary, content.getBytes(UTF8));
                    try {
                        Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING,
                                StandardCopyOption.ATOMIC_MOVE);
                    } catch (AtomicMoveNotSupportedException ex) {
                        Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
                    }
                } finally {
                    Files.deleteIfExists(temporary);
                }
            }
            sendJson(exchange, 200, singleton("path", relativePath(file)));
            return;
        }
        methodNotAllowed(exchange, "GET, PUT");
    }

    private Object suiteModel(HttpExchange exchange) throws Exception {
        String suiteName = queryParameters(exchange.getRequestURI()).get("suite");
        Path suiteDirectory = directSuiteDirectory(suiteName);
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("suite", suiteName);
        result.put("displayName", suiteName.replace('_', ' '));
        List<Object> definitions = new ArrayList<Object>();
        for (Path suiteFile : directXmlFiles(suiteDirectory, "suite")) {
            definitions.add(suiteDefinition(suiteFile));
        }
        result.put("definitions", definitions);
        return result;
    }

    private Map<String, Object> suiteDefinition(Path suiteFile) throws Exception {
        Document document = parseXml(suiteFile);
        Element suite = document.getDocumentElement();
        String sourcePath = relativePath(suiteFile);
        Map<String, Object> definition = new LinkedHashMap<String, Object>();
        definition.put("path", sourcePath);
        definition.put("name", suiteFile.getFileName().toString());
        List<Object> definitionFields = new ArrayList<Object>();
        addAttributeField(definitionFields, suite, "name", sourcePath, "0", null);
        addAttributeField(definitionFields, suite, "parallel", sourcePath, "0", null);
        addAttributeField(definitionFields, suite, "preserve-order", sourcePath, "0", null);
        addFieldRevisions(definitionFields, revision(Files.readAllBytes(suiteFile)));
        definition.put("fields", definitionFields);

        List<Object> tests = new ArrayList<Object>();
        for (Element test : directChildren(suite, "test")) {
            tests.add(testModel(test, sourcePath, elementPath(test)));
        }
        definition.put("tests", tests);
        return definition;
    }

    private Map<String, Object> testModel(Element test, String suitePath, String testNodePath) throws Exception {
        Element inputParameter = namedParameter(test, "xmlTemplateFile");
        Element labelParameter = namedParameter(test, "testFilterLabel");
        String inputValue = attribute(inputParameter, "value");
        String label = attribute(labelParameter, "value");
        Map<String, Object> model = new LinkedHashMap<String, Object>();
        model.put("name", test.getAttribute("name"));
        model.put("nodePath", testNodePath);
        model.put("revision", revision(Files.readAllBytes(resolveEditableXml(suitePath, true))));
        model.put("label", label);
        model.put("inputPath", inputValue);
        List<Object> methods = new ArrayList<Object>();
        NodeList includes = test.getElementsByTagName("include");
        for (int i = 0; i < includes.getLength(); i++) {
            Element include = (Element) includes.item(i);
            if (include.hasAttribute("name")) methods.add(include.getAttribute("name"));
        }
        model.put("methods", methods);
        model.put("enabled", !test.hasAttribute("enabled")
                || Boolean.parseBoolean(test.getAttribute("enabled")));
        List<Object> fields = new ArrayList<Object>();
        addAttributeField(fields, test, "name", suitePath, testNodePath, null);
        addAttributeField(fields, test, "enabled", suitePath, testNodePath, null);
        if (inputParameter != null) {
            addAttributeField(fields, inputParameter, "value", suitePath, elementPath(inputParameter), "string");
        }
        if (labelParameter != null) {
            addAttributeField(fields, labelParameter, "value", suitePath, elementPath(labelParameter), "string");
        }
        addFieldRevisions(fields, revision(Files.readAllBytes(resolveEditableXml(suitePath, true))));
        boolean userDefinition = isUserTest(inputValue, label, metadata());
        model.put("fields", fields);
        model.put("userDefinition", userDefinition);
        model.put("scenarios", scenarios(inputValue, label, userDefinition));
        try {
            Path input = resolveEditableXml(inputValue, true);
            Document inputDocument = parseXml(input);
            Set<String> available = new LinkedHashSet<String>();
            Element data = directChild(inputDocument.getDocumentElement(), "testData");
            if (data != null) for (Element scenario : directChildren(data, "test")) {
                Element labels = directChild(scenario, "labels");
                if (labels != null) for (String token : labels.getTextContent().split(",")) {
                    if (!token.isEmpty() && !token.startsWith("__APP_UNION_")) available.add(token);
                }
            }
            model.put("availableLabels", new ArrayList<String>(available));
            String baseLabel = filterBase(label);
            Object stored = metadata().get("label:" + baseLabel);
            model.put("selectedLabels", stored instanceof List ? stored : Arrays.asList(baseLabel));
        } catch (HttpError ignored) { model.put("availableLabels", Collections.emptyList()); }
        return model;
    }

    private List<Object> scenarios(String inputValue, String filterLabel, boolean userDefinition) throws Exception {
        List<Object> result = new ArrayList<Object>();
        if (inputValue.length() == 0 || filterLabel.length() == 0) return result;
        Path inputFile;
        try {
            inputFile = resolveEditableXml(inputValue, true);
        } catch (HttpError error) {
            return result;
        }
        Document document = parseXml(inputFile);
        Element rootElement = document.getDocumentElement();
        Map<String, String> constants = headerConstants(rootElement);
        Map<String, String> types = headerParameterTypes(rootElement);
        String sourcePath = relativePath(inputFile);
        Element testData = directChild(rootElement, "testData");
        if (testData == null) return result;
        for (Element test : directChildren(testData, "test")) {
            Element labelsElement = directChild(test, "labels");
            if (labelsElement == null || !containsLabel(labelsElement.getTextContent(), filterBase(filterLabel))
                    || !filterIdMatches(test, filterLabel)) continue;
            Element idElement = directChild(test, "id");
            Map<String, Object> scenario = new LinkedHashMap<String, Object>();
            scenario.put("id", idElement == null ? "" : idElement.getTextContent().trim());
            scenario.put("labels", labelsElement.getTextContent().trim());
            List<Object> fields = new ArrayList<Object>();
            Map<String, Boolean> usedLabels = new LinkedHashMap<String, Boolean>();
            usedLabels.put("id", Boolean.TRUE);
            usedLabels.put("labels", Boolean.TRUE);
            for (Element parameter : directChildren(test, "parameter")) {
                usedLabels.put(parameter.getAttribute("name").toLowerCase(Locale.ROOT), Boolean.TRUE);
            }
            if (userDefinition) {
                for (Element constant : constants(document)) {
                    String name = constant.getAttribute("name");
                    String normalizedName = name.toLowerCase(Locale.ROOT);
                    if (!constant.hasAttribute("constValue") || name.startsWith("__META_")
                            || name.startsWith("_TEST_") || "CURRENT_YEAR".equals(name)
                            || usedLabels.containsKey(normalizedName)) continue;
                    addAttributeField(fields, constant, "constValue", sourcePath, elementPath(constant), null);
                    usedLabels.put(normalizedName, Boolean.TRUE);
                }
            }
            if (idElement != null) addTextField(fields, idElement, sourcePath, "id", null);
            addTextField(fields, labelsElement, sourcePath, "labels", "string");
            Map<String, String> values = new LinkedHashMap<String, String>();
            Element header = directChild(rootElement, "header");
            if (header != null) for (Element parameter : descendants(header, "parameter"))
                if (parameter.hasAttribute("name") && parameter.hasAttribute("defaultValue"))
                    values.put(parameter.getAttribute("name"), parameter.getAttribute("defaultValue"));
            for (Element parameter : directChildren(test, "parameter")) {
                if (!parameter.hasAttribute("paramValue")) continue;
                String name = parameter.getAttribute("name");
                String declaredType = types.get(name);
                addAttributeField(fields, parameter, "paramValue", sourcePath,
                        elementPath(parameter), declaredType);
                values.put(name, parameter.getAttribute("paramValue"));
            }
            scenario.put("fields", fields);
            Map<String, Object> metadata = metadata();
            String sourceRevision = revision(Files.readAllBytes(inputFile));
            for (Object item : fields) {
                @SuppressWarnings("unchecked") Map<String, Object> field = (Map<String, Object>) item;
                String name = (String) field.get("label");
                field.put("name", name);
                field.put("revision", sourceRevision);
                String declared = types.get(name);
                field.put("declaredType", declared);
                Object saved = metadata.get("type:" + sourcePath + ":" + name);
                String editor = saved instanceof String ? (String) saved
                        : (name.toUpperCase(Locale.ROOT).contains("MILLIS") ? "unixTimestamp" : field.get("type").toString());
                field.put("editorType", editor);
            }
            Map<String, Object> references = references(values, constants);
            scenario.put("references", references);
            scenario.put("validations", validationModels(castStringList(references.get("validationPaths"))));
            result.add(scenario);
        }
        return result;
    }

    private Map<String, Object> references(Map<String, String> values, Map<String, String> constants)
            throws IOException {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        String template = existingReference(values.get("wsRequestTemplate"), constants);
        if (template != null) result.put("templatePath", template);
        List<String> validations = existingReferences(values.get("testExtension"), constants);
        List<String> sessions = new ArrayList<String>();
        String sessionList = values.get("sessionDefinitionFileList");
        if (sessionList != null && !sessionList.trim().isEmpty()) {
            for (String part : sessionList.split(",")) {
                try {
                    Path session = resolveSessionFile(resolveConstants(part.trim(), constants));
                    sessions.add(relativePath(session));
                    String extension = sessionExtension(new String(Files.readAllBytes(session), UTF8));
                    if (extension != null && !extension.isEmpty()) {
                        String path = resolveSessionExtension(extension, constants, values);
                        Path validation = resolveEditableXml(path, true);
                        String relative = relativePath(validation);
                        if (!validations.contains(relative)) validations.add(relative);
                    }
                } catch (Exception ignored) {
                    // Invalid or unresolved dependencies are rejected when creating an independent copy.
                }
            }
        }
        result.put("validationPaths", validations);
        result.put("sessionPaths", sessions);
        return result;
    }

    private List<Object> validationModels(List<String> paths) throws Exception {
        List<Object> result = new ArrayList<Object>();
        for (String path : paths) {
            Path file = resolveEditableXml(path, true);
            Document document = parseXml(file);
            Map<String, Object> validation = new LinkedHashMap<String, Object>();
            validation.put("path", relativePath(file));
            validation.put("name", file.getFileName().toString());
            List<Object> groups = new ArrayList<Object>();
            Element rootElement = document.getDocumentElement();
            List<Element> executionPoints = descendants(rootElement, "executionPoint");
            if (executionPoints.isEmpty()) {
                addValidationGroups(rootElement, relativePath(file), "Validation", groups);
            } else {
                for (Element point : executionPoints) {
                    String title = "Execution point";
                    if (point.hasAttribute("id")) title += " " + point.getAttribute("id");
                    addValidationGroups(point, relativePath(file), title, groups);
                }
            }
            validation.put("groups", groups);
            String validationRevision = revision(Files.readAllBytes(file));
            for (Object group : groups) {
                @SuppressWarnings("unchecked") Map<String, Object> groupMap = (Map<String, Object>) group;
                @SuppressWarnings("unchecked") List<Object> groupFields = (List<Object>) groupMap.get("fields");
                addFieldRevisions(groupFields, validationRevision);
            }
            result.add(validation);
        }
        return result;
    }

    private void addValidationGroups(Element container, String sourcePath, String title, List<Object> groups) {
        List<Element> boundaries = new ArrayList<Element>();
        collectValidationBoundaries(container, boundaries);
        if (boundaries.isEmpty()) {
            addValidationGroup(container, sourcePath, title, groups);
            return;
        }
        List<Object> containerFields = new ArrayList<Object>();
        collectEditableFields(container, sourcePath, containerFields, boundaries);
        if (!containerFields.isEmpty()) addGroup(groups, title, containerFields);
        for (Element boundary : boundaries) {
            String boundaryTitle = localName(boundary);
            String identity = boundary.hasAttribute("name") ? boundary.getAttribute("name")
                    : boundary.hasAttribute("id") ? boundary.getAttribute("id") : "";
            if (identity.length() > 0) boundaryTitle += ": " + identity;
            addValidationGroup(boundary, sourcePath, title + " / " + boundaryTitle, groups);
        }
    }

    private void addValidationGroup(Element element, String sourcePath, String title, List<Object> groups) {
        List<Object> fields = new ArrayList<Object>();
        collectEditableFields(element, sourcePath, fields, Collections.<Element>emptyList());
        if (!fields.isEmpty()) addGroup(groups, title, fields);
    }

    private static void addGroup(List<Object> groups, String title, List<Object> fields) {
        Map<String, Object> group = new LinkedHashMap<String, Object>();
        group.put("title", title);
        group.put("fields", fields);
        groups.add(group);
    }

    private static void addFieldRevisions(List<Object> fields, String revision) {
        for (Object item : fields) {
            @SuppressWarnings("unchecked") Map<String, Object> field = (Map<String, Object>) item;
            field.put("revision", revision);
            field.put("name", field.get("label"));
        }
    }

    private void collectValidationBoundaries(Element container, List<Element> result) {
        for (Element child : directChildren(container, null)) {
            String name = localName(child).toLowerCase(Locale.ROOT);
            if ("validate".equals(name) || "cit".equals(name) || "detail".equals(name)) {
                result.add(child);
            } else {
                collectValidationBoundaries(child, result);
            }
        }
    }

    private void collectEditableFields(Element element, String sourcePath, List<Object> fields,
            List<Element> excludedTrees) {
        if (excludedTrees.contains(element)) return;
        String path = elementPath(element);
        NamedNodeMap attributes = element.getAttributes();
        for (int i = 0; i < attributes.getLength(); i++) {
            Attr attr = (Attr) attributes.item(i);
            if (XMLConstants.XMLNS_ATTRIBUTE_NS_URI.equals(attr.getNamespaceURI())
                    || "xmlns".equals(attr.getName()) || attr.getName().startsWith("xmlns:")) continue;
            fields.add(field(localName(element) + " @" + attr.getName(), attr.getValue(),
                    inferType(attr.getValue()), sourcePath, path, attr.getName()));
        }
        boolean hasElementChild = false;
        for (Node child = element.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child.getNodeType() == Node.ELEMENT_NODE) {
                hasElementChild = true;
                collectEditableFields((Element) child, sourcePath, fields, excludedTrees);
            }
        }
        String text = element.getTextContent();
        if (!hasElementChild && text != null && text.trim().length() > 0) {
            fields.add(field(localName(element), text.trim(), inferType(text.trim()),
                    sourcePath, path, "#text"));
        }
    }

    private static String revision(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder text = new StringBuilder();
        for (byte b : digest) text.append(String.format(Locale.ROOT, "%02x", b & 255));
        return text.toString();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> metadata() throws Exception {
        Path file = root.resolve(Paths.get("app", "config-metadata.json"));
        if (!Files.exists(file)) return new LinkedHashMap<String, Object>();
        Object value = new JsonParser(new String(Files.readAllBytes(file), UTF8)).parse();
        if (!(value instanceof Map)) throw new HttpError(400, "Invalid application metadata");
        return (Map<String, Object>) value;
    }

    private String transactionPath(Path path) {
        return root.relativize(path).toString().replace('\\', '/');
    }

    private final class ChangeSet {
        final Map<Path, byte[]> originals = new LinkedHashMap<Path, byte[]>();
        final Map<Path, byte[]> updates = new LinkedHashMap<Path, byte[]>();
        final List<Object> impact = new ArrayList<Object>();
        final List<Object> warnings = new ArrayList<Object>();
        final Map<String, Object> data = new LinkedHashMap<String, Object>();

        byte[] read(Path path) throws Exception {
            if (!originals.containsKey(path)) {
                if (Files.exists(path) && (!Files.isRegularFile(path) || !path.toRealPath().startsWith(root)))
                    throw new HttpError(400, "Invalid file: " + transactionPath(path));
                originals.put(path, Files.exists(path) ? Files.readAllBytes(path) : null);
            }
            return originals.get(path);
        }
        Document document(Path path) throws Exception {
            byte[] bytes = read(path);
            if (bytes == null) throw new HttpError(404, "File not found: " + transactionPath(path));
            return parseXml(bytes);
        }
        void xml(Path path, Document document) throws Exception {
            byte[] original = read(path);
            byte[] bytes = serializeXml(document, original == null ? new byte[0] : original);
            parseXml(bytes);
            if ("testTemplate".equals(localName(document.getDocumentElement()))) {
                Path schemaPath = testRoot.resolve(Paths.get("common", "xsd", "test-inputs.xsd"));
                read(schemaPath);
                try {
                    SchemaFactory factory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
                    factory.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
                    factory.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
                    factory.newSchema(schemaPath.toFile()).newValidator()
                            .validate(new javax.xml.transform.stream.StreamSource(new ByteArrayInputStream(bytes)));
                } catch (Exception ex) { throw new HttpError(400, "Input schema validation failed for " + transactionPath(path) + ": " + safeMessage(ex)); }
            }
            updates.put(path, bytes);
        }
        void bytes(Path path, byte[] bytes) throws Exception { read(path); updates.put(path, bytes); }
        Map<String, Object> revisions() throws Exception {
            Map<String, Object> result = new LinkedHashMap<String, Object>();
            for (Map.Entry<Path, byte[]> entry : originals.entrySet())
                result.put(transactionPath(entry.getKey()), entry.getValue() == null ? null : revision(entry.getValue()));
            return result;
        }
        Map<String, Object> result(String operation) throws Exception {
            Map<String, Object> result = new LinkedHashMap<String, Object>();
            result.put("operation", operation);
            result.put("revisions", revisions());
            List<Object> changes = new ArrayList<Object>();
            for (Path path : updates.keySet()) {
                Map<String, Object> change = new LinkedHashMap<String, Object>();
                change.put("path", transactionPath(path));
                change.put("action", originals.get(path) == null ? "create" : "update");
                changes.add(change);
            }
            result.put("changes", changes); result.put("impact", impact);
            result.put("warnings", warnings); result.put("data", data);
            return result;
        }
        void commit(Map<String, Object> expected) throws Exception {
            if (!revisions().equals(expected)) throw new HttpError(409, "Preview is stale; preview again");
            for (Path path : originals.keySet()) {
                byte[] current = Files.exists(path) ? Files.readAllBytes(path) : null;
                if (!Arrays.equals(current, originals.get(path))) throw new HttpError(409, "File changed: " + transactionPath(path));
            }
            Map<Path, Path> staged = new LinkedHashMap<Path, Path>();
            List<Path> written = new ArrayList<Path>();
            try {
                for (Map.Entry<Path, byte[]> entry : updates.entrySet()) {
                    Path path = entry.getKey();
                    if (!Files.isDirectory(path.getParent()) || !path.getParent().toRealPath().startsWith(root))
                        throw new HttpError(400, "Invalid destination directory");
                    Path temp = path.resolveSibling("." + path.getFileName() + "." + UUID.randomUUID() + ".tmp");
                    staged.put(path, temp);
                    Files.write(temp, entry.getValue());
                }
                for (Path path : staged.keySet()) {
                    byte[] current = Files.exists(path) ? Files.readAllBytes(path) : null;
                    if (!Arrays.equals(current, originals.get(path))) throw new HttpError(409, "File changed: " + transactionPath(path));
                    moveReplace(staged.get(path), path);
                    written.add(path);
                }
            } catch (Exception failure) {
                for (int i = written.size() - 1; i >= 0; i--) {
                    Path path = written.get(i);
                    try {
                        if (!Arrays.equals(Files.readAllBytes(path), updates.get(path)))
                            throw new IOException("File changed during rollback: " + transactionPath(path));
                        byte[] previous = originals.get(path);
                        if (previous == null) Files.delete(path);
                        else {
                            Path backup = path.resolveSibling("." + path.getFileName() + "." + UUID.randomUUID() + ".tmp");
                            try { Files.write(backup, previous); moveReplace(backup, path); }
                            finally { Files.deleteIfExists(backup); }
                        }
                    } catch (Exception rollback) { failure.addSuppressed(rollback); }
                }
                if (failure.getSuppressed().length > 0) throw new IOException("Transaction failed; rollback incomplete: " + safeMessage(failure.getSuppressed()[0]), failure);
                throw failure;
            } finally { for (Path temp : staged.values()) Files.deleteIfExists(temp); }
        }
    }

    private static void moveReplace(Path source, Path target) throws IOException {
        try { Files.move(source, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
        catch (AtomicMoveNotSupportedException ex) { Files.move(source, target, StandardCopyOption.REPLACE_EXISTING); }
    }

    private static byte[] serializeXml(Document document, byte[] original) throws Exception {
        TransformerFactory factory = TransformerFactory.newInstance();
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        setTransformerAttribute(factory, XMLConstants.ACCESS_EXTERNAL_DTD, "");
        setTransformerAttribute(factory, XMLConstants.ACCESS_EXTERNAL_STYLESHEET, "");
        Transformer transformer = factory.newTransformer();
        transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
        transformer.setOutputProperty(OutputKeys.INDENT, "no");
        transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION,
                new String(original, UTF8).trim().startsWith("<?xml") ? "no" : "yes");
        DocumentType doctype = document.getDoctype();
        if (doctype != null) {
            if (doctype.getPublicId() != null) transformer.setOutputProperty(OutputKeys.DOCTYPE_PUBLIC, doctype.getPublicId());
            if (doctype.getSystemId() != null) transformer.setOutputProperty(OutputKeys.DOCTYPE_SYSTEM, doctype.getSystemId());
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        transformer.transform(new DOMSource(document), new StreamResult(out));
        return out.toByteArray();
    }

    private Object configMutation(Map<String, Object> body, boolean commit) throws Exception {
        synchronized (xmlWriteLock) {
            String operation = requiredString(body, "operation");
            ChangeSet changes = new ChangeSet();
            if ("year".equals(operation)) prepareYear(changes, body);
            else if ("common".equals(operation)) prepareCommon(changes, body);
            else if ("common-type".equals(operation)) prepareCommonType(changes, body);
            else if ("type".equals(operation)) prepareType(changes, body);
            else if ("labels".equals(operation)) prepareLabels(changes, body);
            else if ("create".equals(operation)) prepareCreate(changes, body);
            else throw new HttpError(400, "Unknown operation");
            Map<String, Object> result = changes.result(operation);
            if (commit) {
                Object revisions = body.get("revisions");
                if (!(revisions instanceof Map)) throw new HttpError(400, "Preview revisions are required");
                @SuppressWarnings("unchecked") Map<String, Object> expected = (Map<String, Object>) revisions;
                changes.commit(expected);
                result.put("saved", Boolean.TRUE);
            }
            return result;
        }
    }

    private List<Path> xmlFiles() throws IOException {
        final List<Path> files = new ArrayList<Path>();
        Files.walkFileTree(testRoot, new java.nio.file.SimpleFileVisitor<Path>() {
            public java.nio.file.FileVisitResult visitFile(Path file, java.nio.file.attribute.BasicFileAttributes attrs) {
                if (attrs.isRegularFile() && file.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".xml")) files.add(file);
                return java.nio.file.FileVisitResult.CONTINUE;
            }
        });
        Collections.sort(files, pathComparator());
        return files;
    }

    private Path suitePath(String value) throws Exception {
        if (value == null || value.isEmpty()) throw new HttpError(400, "suitePath is required");
        Path path = resolveEditableXml(value, true);
        if (!path.getFileName().toString().toLowerCase(Locale.ROOT).startsWith("suite")
                || !"suite".equals(localName(parseXml(path).getDocumentElement())))
            throw new HttpError(400, "Not a suite definition");
        return path;
    }

    private static List<Element> constants(Document document) {
        Element header = directChild(document.getDocumentElement(), "header");
        return header == null ? Collections.<Element>emptyList() : descendants(header, "constant");
    }

    private static boolean isUserTest(String input, String filter, Map<String, Object> metadata) {
        String path = input.replace('\\', '/');
        String name = path.substring(path.lastIndexOf('/') + 1);
        if (name.toLowerCase(Locale.ROOT).contains("user") || filter.toUpperCase(Locale.ROOT).contains("SUAC")) return true;
        Object selected = metadata.get("label:" + filterBase(filter));
        if (selected instanceof List) for (Object label : (List<?>) selected)
            if (label instanceof String && ((String) label).toUpperCase(Locale.ROOT).contains("SUAC")) return true;
        return false;
    }

    private List<Path> yearFiles(ChangeSet change) throws Exception {
        List<Path> files = new ArrayList<Path>();
        for (Path path : xmlFiles()) {
            byte[] bytes = Files.readAllBytes(path);
            if (!new String(bytes, UTF8).contains("CURRENT_YEAR")) continue;
            Document document;
            try { document = parseXml(bytes); } catch (Exception ex) { continue; }
            if (!"testTemplate".equals(localName(document.getDocumentElement()))) continue;
            for (Element constant : constants(document)) {
                if ("CURRENT_YEAR".equals(constant.getAttribute("name")) && constant.hasAttribute("constValue")) {
                    if (change != null) change.read(path);
                    files.add(path); break;
                }
            }
        }
        return files;
    }

    private Map<String, Object> yearModel() throws Exception {
        List<Object> files = new ArrayList<Object>();
        Set<String> values = new LinkedHashSet<String>();
        for (Path path : yearFiles(null)) {
            byte[] bytes = Files.readAllBytes(path);
            for (Element c : constants(parseXml(bytes))) if ("CURRENT_YEAR".equals(c.getAttribute("name")) && c.hasAttribute("constValue")) {
                String value = c.getAttribute("constValue");
                values.add(value);
                Map<String, Object> item = new LinkedHashMap<String, Object>();
                item.put("path", relativePath(path)); item.put("value", value); item.put("revision", revision(bytes)); files.add(item);
            }
        }
        String value = values.size() == 1 ? values.iterator().next() : "";
        String mode = values.size() > 1 ? "mixed" : "$DATE_TIME_NOW_items.Year".equals(value) || values.isEmpty()
                ? "automatic" : value.matches("[0-9]{4}") ? "fixed" : "mixed";
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("mode", mode); result.put("value", "automatic".equals(mode) ? String.valueOf(Year.now().getValue()) : value);
        result.put("mixed", "mixed".equals(mode)); result.put("files", files); return result;
    }

    private void prepareYear(ChangeSet changes, Map<String, Object> body) throws Exception {
        String mode = requiredString(body, "mode");
        String value;
        if ("automatic".equals(mode)) value = "$DATE_TIME_NOW_items.Year";
        else if ("fixed".equals(mode)) {
            value = requiredString(body, "value");
            if (!value.matches("[0-9]{4}") || "0000".equals(value)) throw new HttpError(400, "Year must be four digits from 0001 to 9999");
        } else throw new HttpError(400, "Invalid year mode");
        for (Path path : yearFiles(changes)) {
            Document document = changes.document(path);
            boolean changed = false;
            for (Element constant : constants(document)) if ("CURRENT_YEAR".equals(constant.getAttribute("name")) && constant.hasAttribute("constValue")) {
                if (!value.equals(constant.getAttribute("constValue"))) { constant.setAttribute("constValue", value); changed = true; }
            }
            if (changed) changes.xml(path, document);
            changes.impact.add(relativePath(path));
        }
        changes.data.put("mode", mode); changes.data.put("value", value);
    }

    private Map<Path, List<String>> suiteInputs(Path suite, ChangeSet changes) throws Exception {
        Document document = changes == null ? parseXml(suite) : changes.document(suite);
        Map<Path, List<String>> inputs = new LinkedHashMap<Path, List<String>>();
        for (Element test : directChildren(document.getDocumentElement(), "test")) {
            String value = attribute(namedParameter(test, "xmlTemplateFile"), "value");
            if (value.isEmpty()) continue;
            try {
                Path input = resolveEditableXml(value, true);
                List<String> names = inputs.get(input);
                if (names == null) { names = new ArrayList<String>(); inputs.put(input, names); }
                names.add(test.getAttribute("name"));
            } catch (HttpError ex) {
                if (changes != null) throw new HttpError(400, "Cannot safely apply common values: unresolved input "
                        + value + " in " + relativePath(suite));
            }
        }
        return inputs;
    }

    private List<String> referencingTests(Path input, ChangeSet changes) throws Exception {
        List<String> result = allReferences(changes).get(input);
        return result == null ? Collections.<String>emptyList() : result;
    }

    private Map<Path, List<String>> allReferences(ChangeSet changes) throws Exception {
        Map<Path, List<String>> result = new LinkedHashMap<Path, List<String>>();
        for (Path path : xmlFiles()) {
            if (!path.getFileName().toString().toLowerCase(Locale.ROOT).startsWith("suite")) continue;
            Document doc;
            try { doc = changes == null ? parseXml(path) : changes.document(path); }
            catch (Exception ex) { continue; }
            if (!"suite".equals(localName(doc.getDocumentElement()))) continue;
            for (Element test : directChildren(doc.getDocumentElement(), "test")) {
                String value = attribute(namedParameter(test, "xmlTemplateFile"), "value");
                try {
                    if (!value.isEmpty()) {
                        Path input = resolveEditableXml(value, true);
                        List<String> tests = result.get(input);
                        if (tests == null) { tests = new ArrayList<String>(); result.put(input, tests); }
                        tests.add(relativePath(path) + " :: " + test.getAttribute("name"));
                    }
                } catch (HttpError ignored) { }
            }
        }
        return result;
    }

    private Map<String, Object> commonModel(String requestedSuite) throws Exception {
        Path suite = suitePath(requestedSuite);
        Map<Path, List<String>> inputs = suiteInputs(suite, null);
        Map<Path, List<String>> references = allReferences(null);
        Set<String> names = new LinkedHashSet<String>();
        Document suiteDocument = parseXml(suite);
        Set<Path> userInputs = new LinkedHashSet<Path>();
        Map<String, Object> editorMetadata = metadata();
        for (Element test : directChildren(suiteDocument.getDocumentElement(), "test")) {
            String input = attribute(namedParameter(test, "xmlTemplateFile"), "value");
            String label = attribute(namedParameter(test, "testFilterLabel"), "value");
            if (!isUserTest(input, label, editorMetadata)) continue;
            try { userInputs.add(resolveEditableXml(input, true)); } catch (HttpError ignored) { }
        }
        for (Path path : userInputs) for (Element c : constants(parseXml(path))) {
            String name = c.getAttribute("name");
            if (c.hasAttribute("constValue") && !name.isEmpty() && !"CURRENT_YEAR".equals(name)
                    && !name.startsWith("_TEST_") && !name.startsWith("__META_")) names.add(name);
        }
        List<Object> properties = new ArrayList<Object>();
        for (String name : names) {
            List<Object> files = new ArrayList<Object>();
            Map<String, List<String>> values = new LinkedHashMap<String, List<String>>();
            Set<String> tests = new LinkedHashSet<String>();
            Set<String> editorTypes = new LinkedHashSet<String>();
            for (Path input : inputs.keySet()) {
                byte[] bytes = Files.readAllBytes(input);
                Document doc = parseXml(bytes);
                List<Element> occurrences = new ArrayList<Element>();
                for (Element c : constants(doc)) if (name.equals(c.getAttribute("name")) && c.hasAttribute("constValue"))
                    occurrences.add(c);
                Element header = directChild(doc.getDocumentElement(), "header");
                if (header != null) for (Element p : descendants(header, "parameter"))
                    if (name.equals(p.getAttribute("name"))) occurrences.add(p);
                for (Element c : occurrences) {
                    boolean parameter = "parameter".equals(localName(c));
                    String attribute = parameter ? "defaultValue" : "constValue";
                    String value = c.hasAttribute(attribute) ? c.getAttribute(attribute) : null;
                    if (!parameter && value != null) {
                        List<String> paths = values.get(value);
                        if (paths == null) { paths = new ArrayList<String>(); values.put(value, paths); }
                        paths.add(relativePath(input));
                    }
                    Map<String, Object> file = new LinkedHashMap<String, Object>();
                    file.put("path", relativePath(input)); file.put("value", value); file.put("revision", revision(bytes));
                    Object savedType = editorMetadata.get("type:" + relativePath(input) + ":" + name);
                    String declared = parameter && c.hasAttribute("type") ? c.getAttribute("type") : null;
                    String editor = savedType instanceof String ? (String) savedType
                            : name.toUpperCase(Locale.ROOT).contains("MILLIS") ? "unixTimestamp"
                            : declared != null ? declared : inferType(value == null ? "" : value);
                    file.put("declaredType", declared);
                    file.put("editorType", editor);
                    file.put("typeSource", savedType instanceof String ? "metadata"
                            : name.toUpperCase(Locale.ROOT).contains("MILLIS") ? "inferred"
                            : declared != null ? "declared" : "inferred");
                    file.put("kind", parameter ? "parameter" : "constant");
                    editorTypes.add(editor);
                    files.add(file);
                    if (references.containsKey(input)) tests.addAll(references.get(input));
                }
            }
            List<Object> groups = new ArrayList<Object>();
            for (Map.Entry<String, List<String>> entry : values.entrySet()) {
                Map<String, Object> group = new LinkedHashMap<String, Object>();
                group.put("value", entry.getKey()); group.put("paths", entry.getValue()); groups.add(group);
            }
            Map<String, Object> property = new LinkedHashMap<String, Object>();
            property.put("name", name); property.put("values", groups); property.put("mixed", values.size() > 1);
            property.put("mixedType", editorTypes.size() > 1);
            property.put("editorType", editorTypes.size() == 1 ? editorTypes.iterator().next() : null);
            property.put("files", files); property.put("tests", new ArrayList<String>(tests)); properties.add(property);
        }
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("suitePath", relativePath(suite)); result.put("properties", properties); return result;
    }

    private void prepareCommon(ChangeSet changes, Map<String, Object> body) throws Exception {
        Path suite = suitePath(requiredString(body, "suitePath"));
        String name = requiredString(body, "name"), value = requiredString(body, "value");
        Map<String, Object> model = commonModel(relativePath(suite));
        boolean found = false;
        @SuppressWarnings("unchecked") List<Map<String, Object>> props = (List<Map<String, Object>>) model.get("properties");
        for (Map<String, Object> property : props) if (name.equals(property.get("name"))) found = true;
        if (!found) throw new HttpError(400, "Not a suite user property");
        Map<String, Object> editorMetadata = metadata(changes);
        Map<Path, List<String>> references = allReferences(changes);
        for (Path input : suiteInputs(suite, changes).keySet()) {
            Document doc = changes.document(input);
            boolean changed = false;
            for (Element c : constants(doc)) if (name.equals(c.getAttribute("name")) && c.hasAttribute("constValue")) {
                Object type = editorMetadata.get("type:" + relativePath(input) + ":" + name);
                if (type instanceof String) validateTypedValue(value, (String) type, changes, relativePath(input));
                if (!value.equals(c.getAttribute("constValue"))) { c.setAttribute("constValue", value); changed = true; }
            }
            if (changed) {
                changes.xml(input, doc);
                if (references.containsKey(input)) changes.impact.addAll(references.get(input));
            }
        }
        changes.data.put("name", name);
    }

    private void prepareCommonType(ChangeSet changes, Map<String, Object> body) throws Exception {
        Path suite = suitePath(requiredString(body, "suitePath"));
        String name = requiredString(body, "name"), editor = requiredString(body, "editorType");
        if (!Arrays.asList("string", "number", "date", "unixTimestamp").contains(editor))
            throw new HttpError(400, "Unsupported editor type");
        boolean replace = body.containsKey("value");
        if (replace && !(body.get("value") instanceof String)) throw new HttpError(400, "Replacement value must be a string");
        String value = replace ? (String) body.get("value") : null;
        Map<String, Object> model = commonModel(relativePath(suite));
        boolean found = false;
        @SuppressWarnings("unchecked") List<Map<String, Object>> props = (List<Map<String, Object>>) model.get("properties");
        for (Map<String, Object> property : props) if (name.equals(property.get("name"))) found = true;
        if (!found) throw new HttpError(400, "Not a suite user property");
        Map<String, Object> editorMetadata = metadata(changes);
        Map<Path, List<String>> references = allReferences(changes);
        String declared = "unixTimestamp".equals(editor) ? "number" : editor;
        Set<String> impact = new LinkedHashSet<String>();
        List<Object> affected = new ArrayList<Object>();
        List<Object> values = new ArrayList<Object>();
        for (Path input : suiteInputs(suite, changes).keySet()) {
            Document doc = changes.document(input);
            Element header = directChild(doc.getDocumentElement(), "header");
            List<Element> occurrences = new ArrayList<Element>();
            for (Element c : constants(doc)) if (name.equals(c.getAttribute("name")) && c.hasAttribute("constValue"))
                occurrences.add(c);
            if (header != null) for (Element p : descendants(header, "parameter"))
                if (name.equals(p.getAttribute("name"))) occurrences.add(p);
            if (occurrences.isEmpty()) continue;
            boolean changed = false;
            for (Element element : occurrences) {
                boolean parameter = "parameter".equals(localName(element));
                if (parameter && !element.hasAttribute("type")) throw new HttpError(400, "Missing declared type at " + relativePath(input));
                String attr = parameter ? "defaultValue" : "constValue";
                if (element.hasAttribute(attr)) {
                    recordCommonTypeValue(values, input, element, attr, replace ? value : element.getAttribute(attr));
                    String next = replace ? value : element.getAttribute(attr);
                    validateTypedValue(next, editor, changes, relativePath(input) + " " + attr);
                    if (replace && !next.equals(element.getAttribute(attr))) { element.setAttribute(attr, next); changed = true; }
                }
                if (parameter) {
                    Element data = directChild(doc.getDocumentElement(), "testData");
                    if (data != null) for (Element test : directChildren(data, "test"))
                        for (Element p : directChildren(test, "parameter"))
                            if (name.equals(p.getAttribute("name")) && p.hasAttribute("paramValue")) {
                                recordCommonTypeValue(values, input, p, "paramValue", replace ? value : p.getAttribute("paramValue"));
                                String next = replace ? value : p.getAttribute("paramValue");
                                validateTypedValue(next, editor, changes, relativePath(input) + " scenario " + elementPath(p));
                                if (replace && !next.equals(p.getAttribute("paramValue"))) { p.setAttribute("paramValue", next); changed = true; }
                            }
                    if (!declared.equals(element.getAttribute("type"))) { element.setAttribute("type", declared); changed = true; }
                }
            }
            if (changed) changes.xml(input, doc);
            editorMetadata.put("type:" + relativePath(input) + ":" + name, editor);
            affected.add(relativePath(input));
            if (references.containsKey(input)) impact.addAll(references.get(input));
        }
        saveMetadata(changes, editorMetadata);
        changes.impact.addAll(impact);
        changes.data.put("name", name); changes.data.put("editorType", editor);
        changes.data.put("declaredType", declared); changes.data.put("files", affected);
        changes.data.put("values", values);
        changes.data.put("replacement", Boolean.valueOf(replace));
    }

    private void recordCommonTypeValue(List<Object> values, Path input, Element element, String attribute, String next) {
        Map<String, Object> item = new LinkedHashMap<String, Object>();
        item.put("path", relativePath(input)); item.put("nodePath", elementPath(element));
        item.put("attribute", attribute); item.put("before", element.getAttribute(attribute)); item.put("after", next);
        values.add(item);
    }

    private Map<String, Object> metadata(ChangeSet changes) throws Exception {
        Path path = root.resolve(Paths.get("app", "config-metadata.json"));
        byte[] bytes = changes.read(path);
        if (bytes == null) return new LinkedHashMap<String, Object>();
        Object value = new JsonParser(new String(bytes, UTF8)).parse();
        if (!(value instanceof Map)) throw new HttpError(400, "Invalid application metadata");
        @SuppressWarnings("unchecked") Map<String, Object> result = (Map<String, Object>) value;
        return result;
    }

    private void saveMetadata(ChangeSet changes, Map<String, Object> metadata) throws Exception {
        changes.bytes(root.resolve(Paths.get("app", "config-metadata.json")), Json.write(metadata).getBytes(UTF8));
    }

    private void validateTypedValue(String value, String type, ChangeSet changes, String where) {
        if (value.contains("$")) {
            changes.warnings.add("Expression at " + where + " cannot be type-checked: " + value);
            return;
        }
        try {
            if ("number".equals(type)) {
                if (!new BigDecimal(value).toPlainString().equals(value)) throw new IllegalArgumentException("lossy number");
            } else if ("unixTimestamp".equals(type)) {
                if (!Long.toString(Long.parseLong(value)).equals(value)) throw new IllegalArgumentException("lossy timestamp");
            } else if ("date".equals(type)) LocalDateTime.parse(value);
        } catch (Exception ex) { throw new HttpError(400, "Incompatible " + type + " value at " + where + ": " + value); }
    }

    private void prepareType(ChangeSet changes, Map<String, Object> body) throws Exception {
        Path input = resolveEditableXml(requiredString(body, "sourcePath"), true);
        String name = requiredString(body, "name"), editor = requiredString(body, "editorType");
        if (!Arrays.asList("string", "number", "date", "unixTimestamp").contains(editor))
            throw new HttpError(400, "Unsupported editor type");
        Document doc = changes.document(input);
        Element header = directChild(doc.getDocumentElement(), "header");
        if (header == null) throw new HttpError(400, "Input has no header");
        Element declaration = null, constant = null;
        for (Element p : descendants(header, "parameter")) if (name.equals(p.getAttribute("name"))) {
            if (declaration != null) throw new HttpError(400, "Ambiguous declaration");
            declaration = p;
        }
        for (Element c : constants(doc)) if (name.equals(c.getAttribute("name"))) {
            if (constant != null) throw new HttpError(400, "Ambiguous constant");
            constant = c;
        }
        if ((declaration == null) == (constant == null)) throw new HttpError(400, "Unknown or ambiguous parameter");
        String declared = null;
        if (declaration != null) {
            if (!declaration.hasAttribute("type")) throw new HttpError(400, "Missing declared type");
            if (declaration.hasAttribute("defaultValue")) validateTypedValue(declaration.getAttribute("defaultValue"), editor, changes, "default");
            Element data = directChild(doc.getDocumentElement(), "testData");
            if (data != null) for (Element test : directChildren(data, "test")) {
                for (Element p : directChildren(test, "parameter")) if (name.equals(p.getAttribute("name")) && p.hasAttribute("paramValue"))
                    validateTypedValue(p.getAttribute("paramValue"), editor, changes, "scenario " + attribute(directChild(test, "id"), "value") + " " + elementPath(p));
            }
            declared = "unixTimestamp".equals(editor) ? "number" : editor;
            if (!declared.equals(declaration.getAttribute("type"))) { declaration.setAttribute("type", declared); changes.xml(input, doc); }
        } else if (constant.hasAttribute("constValue")) validateTypedValue(constant.getAttribute("constValue"), editor, changes, name);
        Map<String, Object> metadata = metadata(changes);
        metadata.put("type:" + relativePath(input) + ":" + name, editor);
        saveMetadata(changes, metadata);
        changes.impact.addAll(referencingTests(input, changes));
        changes.data.put("name", name); changes.data.put("editorType", editor); changes.data.put("declaredType", declared);
    }

    @SuppressWarnings("unchecked")
    private static List<String> requestedLabels(Map<String, Object> body) {
        Object raw = body.get("labels");
        if (!(raw instanceof List) || ((List<?>) raw).isEmpty()) throw new HttpError(400, "Select at least one label");
        Set<String> result = new LinkedHashSet<String>();
        for (Object value : (List<Object>) raw) {
            if (!(value instanceof String) || ((String) value).isEmpty()
                    || ((String) value).contains(",") || ((String) value).contains(":") || ((String) value).startsWith("__APP_UNION_"))
                throw new HttpError(400, "Invalid label");
            result.add((String) value);
        }
        return new ArrayList<String>(result);
    }

    private Element selectedSuiteTest(Document doc, String nodePath) {
        Element test = locateElement(doc, nodePath);
        if (!"test".equals(localName(test)) || test.getParentNode() != doc.getDocumentElement())
            throw new HttpError(400, "Expected a suite test");
        return test;
    }

    private void prepareLabels(ChangeSet changes, Map<String, Object> body) throws Exception {
        Path suite = suitePath(requiredString(body, "suitePath"));
        Document suiteDoc = changes.document(suite);
        Element test = selectedSuiteTest(suiteDoc, requiredString(body, "testNodePath"));
        Element filter = namedParameter(test, "testFilterLabel");
        if (filter == null || !filter.hasAttribute("value")) throw new HttpError(400, "Test has no label filter");
        Path input = resolveEditableXml(attribute(namedParameter(test, "xmlTemplateFile"), "value"), true);
        Document inputDoc = changes.document(input);
        Element data = directChild(inputDoc.getDocumentElement(), "testData");
        if (data == null) throw new HttpError(400, "Input has no test data");
        List<String> labels = requestedLabels(body);
        Set<String> seen = new LinkedHashSet<String>();
        int count = 0;
        String oldFilter = filter.getAttribute("value");
        String suffix = oldFilter.contains(":") ? oldFilter.substring(oldFilter.indexOf(':')) : "";
        String runnerLabel = labels.size() == 1 ? labels.get(0)
                : "__APP_UNION_" + revision((relativePath(suite) + ":" + elementPath(test)).getBytes(UTF8)).substring(0, 20).toUpperCase(Locale.ROOT);
        if (labels.size() > 1) {
            for (Path other : xmlFiles()) if (other.getFileName().toString().toLowerCase(Locale.ROOT).startsWith("suite")) {
                Document otherDoc;
                try { otherDoc = changes.document(other); } catch (Exception ex) { continue; }
                if (!"suite".equals(localName(otherDoc.getDocumentElement()))) continue;
                for (Element otherTest : directChildren(otherDoc.getDocumentElement(), "test")) {
                    if (other.equals(suite) && elementPath(otherTest).equals(elementPath(test))) continue;
                    if (runnerLabel.equals(filterBase(attribute(namedParameter(otherTest, "testFilterLabel"), "value")))) {
                        String otherInput = attribute(namedParameter(otherTest, "xmlTemplateFile"), "value");
                        try {
                            if (resolveEditableXml(otherInput, true).equals(input))
                                throw new HttpError(409, "Managed label is shared by another test; cannot safely change it");
                        } catch (HttpError ex) { if (ex.status == 409) throw ex; }
                    }
                }
            }
        }
        boolean inputChanged = false;
        for (Element scenario : directChildren(data, "test")) {
            Element element = directChild(scenario, "labels");
            if (element == null) continue;
            List<String> tokens = new ArrayList<String>(Arrays.asList(element.getTextContent().split(",", -1)));
            boolean match = false;
            for (String label : labels) if (tokens.contains(label)) { seen.add(label); match = true; }
            if (match && filterIdMatches(scenario, oldFilter)) count++;
            if (labels.size() > 1) {
                boolean had = tokens.remove(runnerLabel);
                if (match) tokens.add(runnerLabel);
                if (had != match) { setLeafText(element, String.join(",", tokens)); inputChanged = true; }
            }
        }
        if (!seen.containsAll(labels)) throw new HttpError(400, "One or more labels do not exist in this input file");
        if (inputChanged) changes.xml(input, inputDoc);
        if (!(runnerLabel + suffix).equals(filter.getAttribute("value"))) { filter.setAttribute("value", runnerLabel + suffix); changes.xml(suite, suiteDoc); }
        Map<String, Object> metadata = metadata(changes);
        if (labels.size() > 1) { metadata.put("label:" + runnerLabel, labels); saveMetadata(changes, metadata); }
        changes.impact.addAll(referencingTests(input, changes));
        changes.data.put("labels", labels); changes.data.put("runnerLabel", runnerLabel + suffix); changes.data.put("scenarioCount", count);
    }

    private Path uniqueCopyPath(Path source, String slug, ChangeSet changes) throws Exception {
        String file = source.getFileName().toString();
        int dot = file.lastIndexOf('.');
        String base = dot < 0 ? file : file.substring(0, dot);
        String extension = dot < 0 ? "" : file.substring(dot);
        for (int n = 1; n < 10000; n++) {
            Path candidate = source.resolveSibling(base + "-" + slug + (n == 1 ? "" : "-" + n) + extension);
            if (changes.read(candidate) == null && !changes.updates.containsKey(candidate)) return candidate;
        }
        throw new HttpError(400, "Could not choose a unique file name");
    }

    private Path resolveSessionFile(String relative) throws IOException {
        if (!relative.toLowerCase(Locale.ROOT).endsWith(".ini")) throw new HttpError(400, "Session definition must be an INI file");
        String path = relative.replace('\\', '/');
        if (path.regionMatches(true, 0, "TEST/", 0, 5)) path = path.substring(5);
        Path candidate = testRoot.resolve(path.replace('/', File.separatorChar)).normalize();
        if (!candidate.startsWith(testRoot) || !Files.isRegularFile(candidate)
                || !candidate.toRealPath().startsWith(testRoot)) throw new HttpError(400, "Session definition not found: " + relative);
        return candidate;
    }

    private static final class IniExtension {
        String value;
        int start;
        int end;
    }

    private static IniExtension parseSessionExtension(String content) {
        IniExtension result = null;
        boolean inExtension = false, foundSection = false;
        Matcher lines = Pattern.compile("(?m)^([^\\r\\n]*)(?:\\r?\\n|\\r|$)").matcher(content);
        while (lines.find()) {
            String line = lines.group(1), trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
            if (trimmed.startsWith("[")) {
                if (!trimmed.matches("\\[[^\\]]+\\]")) throw new HttpError(400, "Ambiguous session section");
                inExtension = "[EXTENSION]".equals(trimmed);
                if (inExtension && foundSection) throw new HttpError(400, "Repeated EXTENSION section");
                if (inExtension) foundSection = true;
            } else if (inExtension) {
                Matcher entry = Pattern.compile("^([ \\t]*testExtension[ \\t]*=[ \\t]*)(.*)$").matcher(line);
                if (entry.matches()) {
                    if (result != null) throw new HttpError(400, "Repeated session testExtension");
                    String value = entry.group(2).trim();
                    if (value.startsWith("\"") || value.startsWith("'") || value.contains("\\")
                            || value.contains("#") || value.contains(";"))
                        throw new HttpError(400, "Ambiguous session validation reference");
                    result = new IniExtension();
                    result.value = value;
                    result.start = lines.start(1) + entry.start(2);
                    result.end = lines.start(1) + entry.end(2);
                } else if (trimmed.startsWith("testExtension")) {
                    throw new HttpError(400, "Ambiguous session testExtension syntax");
                }
            }
        }
        return result;
    }

    private static String sessionExtension(String content) {
        IniExtension entry = parseSessionExtension(content);
        return entry == null ? null : entry.value;
    }

    private static String resolveSessionExtension(String value, Map<String, String> constants, Map<String, String> values) {
        Matcher matcher = Pattern.compile("\\$\\{TEST_INPUT/([^}]+)\\}").matcher(value);
        StringBuffer resolved = new StringBuffer();
        while (matcher.find()) {
            String name = matcher.group(1);
            String replacement = values.containsKey(name) ? values.get(name) : constants.get(name);
            if (replacement == null) throw new HttpError(400, "Unresolved session validation reference: " + value);
            matcher.appendReplacement(resolved, Matcher.quoteReplacement(replacement));
        }
        matcher.appendTail(resolved);
        String result = resolveConstants(resolved.toString(), constants);
        if (result.contains("$") || result.contains(",") || result.contains("|"))
            throw new HttpError(400, "Unresolved or ambiguous session validation reference: " + value);
        return result;
    }

    private Path copyValidation(Path validation, String slug, ChangeSet changes, Map<Path, Path> copies) throws Exception {
        Path copy = copies.get(validation);
        if (copy == null) {
            Document document = changes.document(validation);
            copy = uniqueCopyPath(validation, slug, changes);
            changes.xml(copy, document);
            copies.put(validation, copy);
        }
        return copy;
    }

    private Map<String, String> scenarioValues(Element rootElement, Element scenario) {
        Map<String, String> values = new LinkedHashMap<String, String>();
        Element header = directChild(rootElement, "header");
        if (header != null) for (Element parameter : descendants(header, "parameter"))
            if (parameter.hasAttribute("name") && parameter.hasAttribute("defaultValue"))
                values.put(parameter.getAttribute("name"), parameter.getAttribute("defaultValue"));
        if (scenario != null) for (Element parameter : directChildren(scenario, "parameter"))
            if (parameter.hasAttribute("name") && parameter.hasAttribute("paramValue"))
                values.put(parameter.getAttribute("name"), parameter.getAttribute("paramValue"));
        return values;
    }

    private String copySessionList(String list, Map<String, String> constants, Map<String, String> values,
            String slug, ChangeSet changes, Map<Path, Path> sessions, Map<Path, String> sessionTargets,
            Map<Path, Path> validations, Set<String> shared) throws Exception {
        List<String> result = new ArrayList<String>();
        for (String part : list.split(",", -1)) {
            Map<String, String> replacements = new LinkedHashMap<String, String>(constants);
            replacements.putAll(values);
            String resolved = resolveConstants(part.trim(), replacements);
            if (resolved.isEmpty() || resolved.contains("$")) throw new HttpError(400, "Unresolved session definition: " + part);
            Path session = resolveSessionFile(resolved);
            byte[] original = changes.read(session);
            String content;
            try {
                content = UTF8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                        .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                        .decode(java.nio.ByteBuffer.wrap(original)).toString();
            } catch (java.nio.charset.CharacterCodingException ex) { throw new HttpError(400, "Session INI is not UTF-8: " + relativePath(session)); }
            Matcher sharedPaths = Pattern.compile("(?m)^[ \\t]*(ci\\.definition|@defaults_file)[ \\t]*=[ \\t]*([^\\r\\n]+)").matcher(content);
            while (sharedPaths.find()) shared.add(relativePath(session) + " :: " + sharedPaths.group(1) + "=" + sharedPaths.group(2).trim());
            IniExtension extension = parseSessionExtension(content);
            String target = extension == null || extension.value.isEmpty() ? ""
                    : resolveSessionExtension(extension.value, constants, values);
            Path validation = target.isEmpty() ? null : resolveEditableXml(target, true);
            String identity = validation == null ? "" : relativePath(validation);
            if (sessionTargets.containsKey(session) && !identity.equals(sessionTargets.get(session)))
                throw new HttpError(400, "Session validation differs across scenarios: " + relativePath(session));
            sessionTargets.put(session, identity);
            Path copy = sessions.get(session);
            if (copy == null) {
                copy = uniqueCopyPath(session, slug, changes);
                if (validation != null) {
                    Path validationCopy = copyValidation(validation, slug, changes, validations);
                    content = content.substring(0, extension.start) + relativePath(validationCopy) + content.substring(extension.end);
                    changes.bytes(copy, content.getBytes(UTF8));
                } else changes.bytes(copy, original);
                sessions.put(session, copy);
            }
            result.add(relativePath(copy));
        }
        return String.join(",", result);
    }

    private void prepareCreate(ChangeSet changes, Map<String, Object> body) throws Exception {
        Path suite = suitePath(requiredString(body, "suitePath"));
        String kind = requiredString(body, "kind"), name = requiredString(body, "name").trim();
        String position = requiredString(body, "position");
        if (!"duplicate".equals(kind) && !"guided".equals(kind)) throw new HttpError(400, "Invalid creation kind");
        if (!"after".equals(position) && !"beforeCleanup".equals(position)) throw new HttpError(400, "Invalid position");
        if (name.isEmpty() || name.length() > 160) throw new HttpError(400, "Invalid test name");
        Document suiteDoc = changes.document(suite);
        Element source = selectedSuiteTest(suiteDoc, requiredString(body, "sourceTestNodePath"));
        for (Element test : directChildren(suiteDoc.getDocumentElement(), "test"))
            if (name.equalsIgnoreCase(test.getAttribute("name"))) throw new HttpError(400, "Test name already exists");
        List<Element> methods = descendants(source, "include");
        Set<String> supported = new LinkedHashSet<String>(Arrays.asList("t990_execute_action", "t930_execute_charge",
                "t920_execute_soap_request", "t999_cleanup_delete_subscriber_from_cc",
                "t900_execute_charging_session", "t500_execute_acquire"));
        if (methods.size() != 1 || !supported.contains(methods.get(0).getAttribute("name")))
            throw new HttpError(400, "Source must use one supported vetted test method");
        Element inputParameter = namedParameter(source, "xmlTemplateFile");
        Element filter = namedParameter(source, "testFilterLabel");
        if (inputParameter == null || filter == null || !inputParameter.hasAttribute("value") || !filter.hasAttribute("value"))
            throw new HttpError(400, "Source requires input and label filters");
        String sourceLabel = filter.getAttribute("value");
        if (sourceLabel.isEmpty() || filterBase(sourceLabel).contains(",")) throw new HttpError(400, "Source has an ambiguous label filter");
        Path sourceInput = resolveEditableXml(inputParameter.getAttribute("value"), true);
        Document inputDoc = changes.document(sourceInput);
        if (!"testTemplate".equals(localName(inputDoc.getDocumentElement()))) throw new HttpError(400, "Invalid source input");
        Element data = directChild(inputDoc.getDocumentElement(), "testData");
        if (data == null) throw new HttpError(400, "Source input has no scenarios");
        int selected = 0;
        for (Element test : directChildren(data, "test")) {
            Element labels = directChild(test, "labels");
            if (labels != null && containsLabel(labels.getTextContent(), filterBase(sourceLabel)) && filterIdMatches(test, sourceLabel)) selected++;
        }
        if (selected == 0) throw new HttpError(400, "Source filter matches no scenarios");
        Map<String, Object> year = yearModel();
        if (Boolean.TRUE.equals(year.get("mixed"))) throw new HttpError(400, "Resolve mixed CURRENT_YEAR values before creating a test");
        String yearValue = "automatic".equals(year.get("mode")) ? "$DATE_TIME_NOW_items.Year" : (String) year.get("value");
        for (Path path : yearFiles(changes)) changes.read(path);
        for (Element c : constants(inputDoc)) if ("CURRENT_YEAR".equals(c.getAttribute("name")) && c.hasAttribute("constValue"))
            c.setAttribute("constValue", yearValue);
        String slug = name.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-+|-+$)", "");
        if (slug.isEmpty()) slug = "test";
        if (slug.length() > 40) slug = slug.substring(0, 40);
        Path newInput = uniqueCopyPath(sourceInput, slug, changes);
        Map<String, String> sourceConstants = headerConstants(inputDoc.getDocumentElement());
        Map<Path, Path> validationCopies = new LinkedHashMap<Path, Path>();
        Map<Path, Path> sessionCopies = new LinkedHashMap<Path, Path>();
        Map<Path, String> sessionTargets = new LinkedHashMap<Path, String>();
        Map<Element, Map<String, String>> contexts = new LinkedHashMap<Element, Map<String, String>>();
        for (Element scenario : directChildren(data, "test"))
            contexts.put(scenario, scenarioValues(inputDoc.getDocumentElement(), scenario));
        Map<String, String> defaults = scenarioValues(inputDoc.getDocumentElement(), null);
        Set<String> shared = new LinkedHashSet<String>();
        for (Element parameter : descendants(inputDoc.getDocumentElement(), "parameter")) {
            String paramName = parameter.getAttribute("name");
            String attributeName = parameter.hasAttribute("paramValue") ? "paramValue"
                    : parameter.hasAttribute("defaultValue") ? "defaultValue" : null;
            if (attributeName == null) continue;
            String value = parameter.getAttribute(attributeName).trim();
            if ("testExtension".equals(paramName) && !value.isEmpty()) {
                String[] parts = value.split("([|,])", -1);
                if (parts.length != 1) throw new HttpError(400, "Ambiguous multiple validation references: " + value);
                String resolved = resolveConstants(value, sourceConstants);
                if (resolved.contains("$")) throw new HttpError(400, "Unresolved validation reference: " + value);
                Path validation = resolveEditableXml(resolved, true);
                Path copy = copyValidation(validation, slug, changes, validationCopies);
                parameter.setAttribute(attributeName, relativePath(copy));
            } else if ("sessionDefinitionFileList".equals(paramName) && !value.isEmpty()) {
                String replacement = null;
                if ("paramValue".equals(attributeName)) {
                    Node parent = parameter.getParentNode();
                    if (!(parent instanceof Element) || !contexts.containsKey(parent))
                        throw new HttpError(400, "Ambiguous session parameter location");
                    replacement = copySessionList(value, sourceConstants, contexts.get(parent), slug,
                            changes, sessionCopies, sessionTargets, validationCopies, shared);
                } else {
                    for (Element scenario : contexts.keySet()) {
                        boolean overridden = false;
                        for (Element p : directChildren(scenario, "parameter"))
                            if ("sessionDefinitionFileList".equals(p.getAttribute("name"))) overridden = true;
                        if (overridden) continue;
                        String candidate = copySessionList(value, sourceConstants, contexts.get(scenario), slug,
                                changes, sessionCopies, sessionTargets, validationCopies, shared);
                        if (replacement != null && !replacement.equals(candidate))
                            throw new HttpError(400, "Session default differs across scenarios");
                        replacement = candidate;
                    }
                    if (replacement == null) replacement = copySessionList(value, sourceConstants, defaults, slug,
                            changes, sessionCopies, sessionTargets, validationCopies, shared);
                }
                parameter.setAttribute(attributeName, replacement);
            } else if (("wsRequestTemplate".equals(paramName) || "acquisitionInputFile".equals(paramName))
                    && !value.isEmpty()) shared.add(value);
        }
        changes.xml(newInput, inputDoc);
        Element duplicate = (Element) source.cloneNode(true);
        duplicate.setAttribute("name", name);
        namedParameter(duplicate, "xmlTemplateFile").setAttribute("value", relativePath(newInput));
        Node before = source.getNextSibling();
        if ("beforeCleanup".equals(position)) {
            before = null;
            List<Element> tests = directChildren(suiteDoc.getDocumentElement(), "test");
            for (int i = tests.size() - 1; i >= 0; i--) {
                Element test = tests.get(i);
                if (test.getTextContent().toLowerCase(Locale.ROOT).contains("cleanup")) { before = test; break; }
                for (Element include : descendants(test, "include"))
                    if (include.getAttribute("name").contains("cleanup")) { before = test; break; }
                if (before != null) break;
            }
        }
        suiteDoc.getDocumentElement().insertBefore(duplicate, before);
        changes.xml(suite, suiteDoc);
        Map<String, Object> metadata = metadata(changes);
        String prefix = "type:" + relativePath(sourceInput) + ":";
        Map<String, Object> copy = new LinkedHashMap<String, Object>();
        for (Map.Entry<String, Object> entry : metadata.entrySet())
            if (entry.getKey().startsWith(prefix)) copy.put("type:" + relativePath(newInput) + ":" + entry.getKey().substring(prefix.length()), entry.getValue());
        if (!copy.isEmpty()) { metadata.putAll(copy); saveMetadata(changes, metadata); }
        changes.impact.add(relativePath(suite) + " :: " + name);
        changes.data.put("sourceInputPath", relativePath(sourceInput)); changes.data.put("newInputPath", relativePath(newInput));
        List<String> paths = new ArrayList<String>(); for (Path path : validationCopies.values()) paths.add(relativePath(path));
        changes.data.put("newValidationPaths", paths); changes.data.put("sharedDependencies", new ArrayList<String>(shared));
        List<String> sessionPaths = new ArrayList<String>();
        for (Path path : sessionCopies.values()) sessionPaths.add(relativePath(path));
        changes.data.put("newSessionPaths", sessionPaths);
        changes.data.put("selectedScenarioCount", selected); changes.data.put("position", position);
        if (!shared.isEmpty()) changes.warnings.add("Listed request, catalog, defaults and acquisition dependencies remain shared");
        if (body.containsKey("labels")) throw new HttpError(400, "Choose labels after creating the test");
    }

    private Object updateField(HttpExchange exchange) throws Exception {
        Map<String, Object> body = readObject(exchange);
        String sourcePath = requiredString(body, "sourcePath");
        String nodePath = requiredString(body, "nodePath");
        String attributeName = requiredString(body, "attribute");
        String value = requiredString(body, "value");
        Path file = resolveEditableXml(sourcePath, true);
        synchronized (xmlWriteLock) {
            byte[] original = Files.readAllBytes(file);
            if (body.containsKey("revision") && !revision(original).equals(requiredString(body, "revision")))
                throw new HttpError(409, "File changed; reload before saving");
            Document document = parseXml(original);
            Element element = locateElement(document, nodePath);
            String current;
            if ("#text".equals(attributeName)) {
                if (hasElementChild(element)) throw new HttpError(400, "#text can only update leaf elements");
                current = element.getTextContent();
            } else {
                if (attributeName.startsWith("xmlns") || !element.hasAttribute(attributeName)) {
                    throw new HttpError(400, "Attribute does not exist");
                }
                current = element.getAttribute(attributeName);
            }
            String name = element.getAttribute("name");
            String declared = headerParameterTypes(document.getDocumentElement()).get(name);
            Object editor = metadata().get("type:" + relativePath(file) + ":" + name);
            if (("paramValue".equals(attributeName) || "constValue".equals(attributeName))
                    && (declared != null || editor instanceof String)) {
                String type = editor instanceof String ? (String) editor : declared;
                validateTypedValue(value, type, new ChangeSet(), name);
            } else {
                validateReplacement(current, value);
            }
            if ("constValue".equals(attributeName) && "CURRENT_YEAR".equals(name))
                throw new HttpError(400, "Use the global year setting");
            if ("testFilterLabel".equals(element.getAttribute("name")) && value.contains(","))
                throw new HttpError(400, "Use the label selection operation for multiple labels");
            if ("#text".equals(attributeName)) {
                setLeafText(element, value);
            } else {
                element.getAttributeNode(attributeName).setValue(value);
            }
            writeXmlAtomically(file, document, original);
        }
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("saved", Boolean.TRUE);
        result.put("sourcePath", relativePath(file));
        result.put("value", value);
        result.put("revision", revision(Files.readAllBytes(file)));
        return result;
    }

    private Object startRun(HttpExchange exchange) throws Exception {
        Map<String, Object> body = readObject(exchange);
        if (body.size() != 1 || !body.containsKey("target")) {
            throw new HttpError(400, "Request must contain only target");
        }
        final String targetName = requiredString(body, "target");
        selectedEnvironment = readSelectedEnvironment();
        TargetDefinition target = findTarget(readRunnableTargets(), targetName);
        if (target == null) throw new HttpError(400, "Unknown or non-runnable target");
        final String environment = targetEnvironment(target, selectedEnvironment);
        final Path log = root.resolve(Paths.get("target", "app-runs", "latest.log"));
        synchronized (runLock) {
            if (runState.running) {
                throw new HttpError(409, "A test run is already in progress");
            }
            Files.createDirectories(log.getParent());
            final RunState next = new RunState();
            next.running = true;
            next.exitCode = null;
            next.target = targetName;
            next.suite = targetName;
            next.environment = environment;
            next.log = log;
            runState = next;
            Thread runner = new Thread(new Runnable() {
                public void run() { executeRun(next); }
            }, "test-suite-runner");
            runner.setDaemon(true);
            runner.start();
        }
        return runStatus();
    }

    private void executeRun(RunState state) {
        int exitCode = -1;
        try {
            TargetDefinition current = findTarget(readRunnableTargets(), state.target);
            if (current == null) throw new IOException("Target is no longer runnable: " + state.target);
            state.environment = targetEnvironment(current, readSelectedEnvironment());
            List<String> command = new ArrayList<String>();
            if (System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) {
                command.add(System.getenv("ComSpec") == null ? "cmd.exe" : System.getenv("ComSpec"));
                command.add("/c");
            }
            command.add("ant");
            command.add("-f");
            command.add("test.xml");
            command.add(state.target);
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(root.toFile());
            builder.redirectErrorStream(true);
            builder.redirectOutput(state.log.toFile());
            exitCode = builder.start().waitFor();
        } catch (Exception ex) {
            try {
                Files.write(state.log, ("Unable to start test run: " + safeMessage(ex) + System.lineSeparator())
                        .getBytes(UTF8));
            } catch (IOException ignored) {
                // Status still exposes the failure even if the log cannot be written.
            }
        } finally {
            synchronized (runLock) {
                state.exitCode = Integer.valueOf(exitCode);
                state.running = false;
            }
        }
    }

    private Map<String, Object> runStatus() throws IOException {
        RunState current = runState;
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("running", current.running);
        result.put("exitCode", current.exitCode);
        result.put("target", current.target);
        result.put("suite", current.suite);
        result.put("environment", current.environment);
        result.put("log", current.log == null ? "" : readTail(current.log));
        return result;
    }

    private void redirectReport(HttpExchange exchange) throws Exception {
        requireMethod(exchange, "GET");
        Path report = findReport();
        if (report == null) {
            throw new HttpError(404, "No report is available");
        }
        String relative = reportsRoot.toAbsolutePath().normalize().relativize(report.toAbsolutePath()).toString();
        String[] parts = relative.replace('\\', '/').split("/");
        StringBuilder location = new StringBuilder("/report/");
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) location.append('/');
            location.append(URLEncoder.encode(parts[i], "UTF-8").replace("+", "%20"));
        }
        exchange.getResponseHeaders().set("Location", location.toString());
        exchange.sendResponseHeaders(302, -1);
        exchange.close();
    }

    private void serveReport(HttpExchange exchange) throws Exception {
        requireMethod(exchange, "GET");
        if (!Files.isDirectory(reportsRoot)) throw new HttpError(404, "Report not found");
        String relative = exchange.getRequestURI().getPath().substring("/report/".length());
        Path file = reportsRoot.resolve(relative).normalize();
        Path canonicalRoot = reportsRoot.toRealPath();
        if (!Files.exists(file) || !file.toRealPath().startsWith(canonicalRoot) || !Files.isRegularFile(file)) {
            throw new HttpError(404, "Report file not found");
        }
        sendFile(exchange, file);
    }

    private void serveStatic(HttpExchange exchange) throws Exception {
        requireMethod(exchange, "GET");
        String path = exchange.getRequestURI().getPath();
        String relative = "/".equals(path) ? "index.html" : path.substring(1);
        Path file = webRoot.resolve(relative).normalize();
        if (!Files.exists(file) || !file.toRealPath().startsWith(webRoot)
                || !Files.isRegularFile(file)) {
            throw new HttpError(404, "Static file not found");
        }
        sendFile(exchange, file);
    }

    private List<Object> suites() throws IOException {
        List<Path> folders = new ArrayList<Path>();
        DirectoryStream<Path> stream = Files.newDirectoryStream(testRoot);
        try {
            for (Path child : stream) {
                if (Files.isDirectory(child) && !isExcludedSuite(child.getFileName().toString())) folders.add(child);
            }
        } finally {
            stream.close();
        }
        Collections.sort(folders, pathComparator());
        List<Object> result = new ArrayList<Object>();
        for (Path folder : folders) {
            Map<String, Object> suite = new LinkedHashMap<String, Object>();
            String name = folder.getFileName().toString();
            suite.put("name", name);
            suite.put("displayName", name.replace('_', ' '));
            Map<String, Object> files = new LinkedHashMap<String, Object>();
            files.put("suites", matchingXml(folder, "suite", false));
            files.put("inputs", matchingXml(folder, "test-input", false));
            files.put("templates", matchingXml(folder.resolve("templates"), "", true));
            files.put("validations", matchingXml(folder.resolve("ext"), "", true));
            suite.put("files", files);
            result.add(suite);
        }
        return result;
    }

    private List<TargetDefinition> readRunnableTargets() throws Exception {
        synchronized (xmlWriteLock) {
            return runnableTargets(parseXml(testFile));
        }
    }

    private List<TargetDefinition> runnableTargets(Document document) throws IOException {
        List<TargetDefinition> result = new ArrayList<TargetDefinition>();
        Element project = document.getDocumentElement();
        for (Element target : directChildren(project, "target")) {
            Element run = directChild(target, "runMultipleSuites");
            if (run == null) continue;
            result.add(targetDefinition(target, run));
        }
        return result;
    }

    private TargetDefinition targetDefinition(Element target, Element run) throws IOException {
        String name = target.getAttribute("name");
        String description = target.getAttribute("description");
        String explicitEnvironment = "";
        Element config = directChild(run, "config");
        if (config != null) {
            for (Element property : directChildren(config, "sysproperty")) {
                if ("ccLandscape".equals(property.getAttribute("key"))) {
                    explicitEnvironment = displayEnvironment(property.getAttribute("value"));
                    break;
                }
            }
        }
        List<String> suites = new ArrayList<String>();
        String reference = run.getAttribute("pXmlFilesetRef");
        for (Element fileset : directChildren(target, "fileset")) {
            if (!reference.equals(fileset.getAttribute("id"))) continue;
            suites.addAll(resolveFilesetSuites(fileset));
            break;
        }
        return new TargetDefinition(name, description, explicitEnvironment, suites, target, run);
    }

    private List<String> resolveFilesetSuites(Element fileset) throws IOException {
        List<String> result = new ArrayList<String>();
        String configuredDir = fileset.getAttribute("dir").trim().replace('\\', '/');
        if (!configuredDir.startsWith("${basedir}/")) return result;
        String relativeDir = configuredDir.substring("${basedir}/".length());
        Path directory = root.resolve(relativeDir.replace('/', File.separatorChar)).normalize();
        if (!directory.startsWith(testRoot) || !Files.isDirectory(directory)) return result;
        Path canonicalDirectory = directory.toRealPath();
        if (!canonicalDirectory.startsWith(testRoot)) return result;
        for (Element include : directChildren(fileset, "include")) {
            String name = include.getAttribute("name").trim().replace('\\', '/');
            if (name.length() == 0) continue;
            Path candidate = canonicalDirectory.resolve(name.replace('/', File.separatorChar)).normalize();
            if (!candidate.startsWith(testRoot) || !Files.isRegularFile(candidate)
                    || !candidate.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".xml")) continue;
            Path canonical = candidate.toRealPath();
            if (!canonical.startsWith(testRoot) || !Files.isRegularFile(canonical)) continue;
            String relative = relativePath(canonical);
            if (!result.contains(relative)) result.add(relative);
        }
        return result;
    }

    private List<Object> targetMaps(List<TargetDefinition> targets, String fallbackEnvironment) {
        List<Object> result = new ArrayList<Object>();
        for (TargetDefinition target : targets) result.add(targetMap(target, fallbackEnvironment));
        return result;
    }

    private Map<String, Object> targetMap(TargetDefinition target, String fallbackEnvironment) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("name", target.name);
        result.put("description", target.description);
        result.put("environment", target.explicitEnvironment.length() == 0
                ? DEFAULT_TARGET_ENVIRONMENT : target.explicitEnvironment);
        result.put("effectiveEnvironment", targetEnvironment(target, fallbackEnvironment));
        result.put("suites", target.suites);
        return result;
    }

    private static String targetEnvironment(TargetDefinition target, String fallbackEnvironment) {
        return target.explicitEnvironment.length() == 0 ? fallbackEnvironment : target.explicitEnvironment;
    }

    private static TargetDefinition findTarget(List<TargetDefinition> targets, String name) {
        for (TargetDefinition target : targets) {
            if (target.name.equals(name)) return target;
        }
        return null;
    }

    private TargetDefinition findRunnableTarget(Document document, String name) throws IOException {
        return findTarget(runnableTargets(document), name);
    }

    private List<String> availableSuiteFiles() throws IOException {
        final List<String> result = new ArrayList<String>();
        Files.walkFileTree(testRoot, new java.nio.file.SimpleFileVisitor<Path>() {
            public java.nio.file.FileVisitResult visitFile(Path file,
                    java.nio.file.attribute.BasicFileAttributes attributes) throws IOException {
                String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
                if (attributes.isRegularFile() && name.startsWith("suite") && name.endsWith(".xml")) {
                    Path canonical = file.toRealPath();
                    if (canonical.startsWith(testRoot)) result.add(relativePath(canonical));
                }
                return java.nio.file.FileVisitResult.CONTINUE;
            }
        });
        Collections.sort(result, String.CASE_INSENSITIVE_ORDER);
        return result;
    }

    private Path resolveSuiteXml(String relative) throws IOException {
        Path file = resolveEditableXml(relative, true).toRealPath();
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        if (!name.startsWith("suite") || !name.endsWith(".xml")) {
            throw new HttpError(400, "Suite files must be existing suite*.xml files under TEST");
        }
        return file;
    }

    private List<String> matchingXml(Path directory, String prefix, boolean allXml) throws IOException {
        List<String> result = new ArrayList<String>();
        if (!Files.isDirectory(directory)) return result;
        DirectoryStream<Path> stream = Files.newDirectoryStream(directory);
        try {
            for (Path file : stream) {
                String name = file.getFileName().toString();
                String lower = name.toLowerCase(Locale.ROOT);
                if (Files.isRegularFile(file) && lower.endsWith(".xml")
                        && (allXml || lower.startsWith(prefix.toLowerCase(Locale.ROOT)))) {
                    result.add(relativePath(file));
                }
            }
        } finally {
            stream.close();
        }
        Collections.sort(result, String.CASE_INSENSITIVE_ORDER);
        return result;
    }

    private List<Environment> loadEnvironments() throws IOException {
        List<Environment> result = new ArrayList<Environment>();
        Pattern fileName = Pattern.compile("sap\\.cc\\.(.+)\\.config\\.properties", Pattern.CASE_INSENSITIVE);
        DirectoryStream<Path> packages = Files.newDirectoryStream(root, "install-package*");
        try {
            for (Path packageDirectory : packages) {
                Path config = packageDirectory.resolve("config");
                if (!Files.isDirectory(config)) continue;
                DirectoryStream<Path> propertyFiles = Files.newDirectoryStream(config, "sap.cc.*.config.properties");
                try {
                    for (Path propertyFile : propertyFiles) {
                        Matcher matcher = fileName.matcher(propertyFile.getFileName().toString());
                        if (!matcher.matches()) continue;
                        Properties loaded = new Properties();
                        Reader reader = Files.newBufferedReader(propertyFile, StandardCharsets.ISO_8859_1);
                        try {
                            loaded.load(reader);
                        } finally {
                            reader.close();
                        }
                        Map<String, String> values = new LinkedHashMap<String, String>();
                        List<String> keys = new ArrayList<String>(loaded.stringPropertyNames());
                        Collections.sort(keys, String.CASE_INSENSITIVE_ORDER);
                        for (String key : keys) {
                            values.put(key, isSecretKey(key) ? "******" : loaded.getProperty(key, ""));
                        }
                        String landscape = matcher.group(1).toUpperCase(Locale.ROOT);
                        String displayName = "QAS".equals(landscape) ? "SQAS" : landscape;
                        result.add(new Environment(displayName, landscape, values));
                    }
                } finally {
                    propertyFiles.close();
                }
            }
        } finally {
            packages.close();
        }
        Collections.sort(result, new Comparator<Environment>() {
            public int compare(Environment left, Environment right) {
                return left.name.compareToIgnoreCase(right.name);
            }
        });
        return result;
    }

    private Path findReport() throws IOException {
        if (!Files.isDirectory(reportsRoot)) return null;
        Path userReport = reportsRoot.resolve(System.getProperty("user.name", "")).resolve("Report.htm");
        if (Files.isRegularFile(userReport)) return userReport;
        final List<Path> reports = new ArrayList<Path>();
        Files.walkFileTree(reportsRoot, new java.nio.file.SimpleFileVisitor<Path>() {
            public java.nio.file.FileVisitResult visitFile(Path file, java.nio.file.attribute.BasicFileAttributes attrs) {
                if ("Report.htm".equalsIgnoreCase(file.getFileName().toString())) reports.add(file);
                return java.nio.file.FileVisitResult.CONTINUE;
            }
        });
        if (reports.isEmpty()) return null;
        Collections.sort(reports, new Comparator<Path>() {
            public int compare(Path left, Path right) {
                try {
                    FileTime a = Files.getLastModifiedTime(left);
                    FileTime b = Files.getLastModifiedTime(right);
                    return b.compareTo(a);
                } catch (IOException ex) {
                    return 0;
                }
            }
        });
        return reports.get(0);
    }

    private Path resolveEditableXml(String relative, boolean mustExist) throws IOException {
        if (!relative.toLowerCase(Locale.ROOT).endsWith(".xml")) throw new HttpError(400, "Only XML files are editable");
        String normalizedRelative = relative.replace('\\', '/');
        if (normalizedRelative.regionMatches(true, 0, "TEST/", 0, 5)) {
            normalizedRelative = normalizedRelative.substring(5);
        }
        Path candidate = testRoot.resolve(normalizedRelative.replace('/', File.separatorChar)).normalize();
        if (!candidate.startsWith(testRoot)) throw new HttpError(400, "Invalid file path");
        if (mustExist && (!Files.isRegularFile(candidate) || !candidate.toRealPath().startsWith(testRoot))) {
            throw new HttpError(404, "XML file not found");
        }
        return candidate;
    }

    private Path directSuiteDirectory(String suiteName) throws IOException {
        if (suiteName == null || !isSimpleName(suiteName) || isExcludedSuite(suiteName)) {
            throw new HttpError(400, "Invalid suite folder");
        }
        Path directory = testRoot.resolve(suiteName).normalize();
        if (!directory.getParent().equals(testRoot) || !Files.isDirectory(directory)
                || !directory.toRealPath().getParent().equals(testRoot)) {
            throw new HttpError(404, "Suite folder not found");
        }
        return directory.toRealPath();
    }

    private List<Path> directXmlFiles(Path directory, String prefix) throws IOException {
        List<Path> result = new ArrayList<Path>();
        DirectoryStream<Path> stream = Files.newDirectoryStream(directory);
        try {
            for (Path file : stream) {
                String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
                if (Files.isRegularFile(file) && name.startsWith(prefix.toLowerCase(Locale.ROOT))
                        && name.endsWith(".xml")) result.add(file);
            }
        } finally {
            stream.close();
        }
        Collections.sort(result, pathComparator());
        return result;
    }

    private static Document parseXml(Path file) throws Exception {
        return parseXml(Files.readAllBytes(file));
    }

    private static Document parseXml(byte[] bytes) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        setFeature(factory, XMLConstants.FEATURE_SECURE_PROCESSING, true);
        setFeature(factory, "http://xml.org/sax/features/external-general-entities", false);
        setFeature(factory, "http://xml.org/sax/features/external-parameter-entities", false);
        setFeature(factory, "http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        setAttribute(factory, XMLConstants.ACCESS_EXTERNAL_DTD, "");
        setAttribute(factory, XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        DocumentBuilder builder = factory.newDocumentBuilder();
        builder.setEntityResolver((publicId, systemId) -> new InputSource(new StringReader("")));
        return builder.parse(new ByteArrayInputStream(bytes));
    }

    private static List<Element> directChildren(Element parent, String wantedLocalName) {
        List<Element> result = new ArrayList<Element>();
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node.getNodeType() != Node.ELEMENT_NODE) continue;
            Element child = (Element) node;
            if (wantedLocalName == null || wantedLocalName.equals(localName(child))) result.add(child);
        }
        return result;
    }

    private static Element directChild(Element parent, String wantedLocalName) {
        List<Element> children = directChildren(parent, wantedLocalName);
        return children.isEmpty() ? null : children.get(0);
    }

    private static List<Element> descendants(Element parent, String wantedLocalName) {
        List<Element> result = new ArrayList<Element>();
        collectDescendants(parent, wantedLocalName, result);
        return result;
    }

    private static void collectDescendants(Element parent, String wantedLocalName, List<Element> result) {
        for (Element child : directChildren(parent, null)) {
            if (wantedLocalName.equals(localName(child))) result.add(child);
            collectDescendants(child, wantedLocalName, result);
        }
    }

    private static String localName(Element element) {
        return element.getLocalName() == null ? element.getTagName() : element.getLocalName();
    }

    private static Element namedParameter(Element parent, String name) {
        for (Element parameter : descendants(parent, "parameter")) {
            if (name.equals(parameter.getAttribute("name"))) return parameter;
        }
        return null;
    }

    private static String attribute(Element element, String name) {
        return element == null ? "" : element.getAttribute(name);
    }

    private static boolean containsLabel(String labels, String wanted) {
        for (String token : labels.split(",")) {
            if (token.equals(wanted)) return true;
        }
        return false;
    }

    private static String filterBase(String filter) {
        int colon = filter.indexOf(':');
        return colon < 0 ? filter : filter.substring(0, colon);
    }

    private static boolean filterIdMatches(Element scenario, String filter) {
        String[] parts = filter.split(":");
        for (int i = 1; i < parts.length; i++) if (parts[i].startsWith("id|")) {
            String[] ids = parts[i].substring(3).replace("|", "").split(" ");
            Element id = directChild(scenario, "id");
            return id != null && Arrays.asList(ids).contains(id.getTextContent());
        }
        return true;
    }

    private static Map<String, String> headerConstants(Element rootElement) {
        Map<String, String> result = new LinkedHashMap<String, String>();
        Element header = directChild(rootElement, "header");
        if (header == null) return result;
        for (Element constant : descendants(header, "constant")) {
            if (constant.hasAttribute("name") && constant.hasAttribute("constValue")) {
                result.put(constant.getAttribute("name"), constant.getAttribute("constValue"));
            }
        }
        return result;
    }

    private static Map<String, String> headerParameterTypes(Element rootElement) {
        Map<String, String> result = new LinkedHashMap<String, String>();
        Element header = directChild(rootElement, "header");
        if (header == null) return result;
        for (Element parameter : descendants(header, "parameter")) {
            if (parameter.hasAttribute("name") && parameter.hasAttribute("type")) {
                result.put(parameter.getAttribute("name"), normalizeDeclaredType(parameter.getAttribute("type")));
            }
        }
        return result;
    }

    private static String normalizeDeclaredType(String type) {
        String lower = type.toLowerCase(Locale.ROOT);
        if ("date".equals(lower)) return "date";
        if (lower.contains("bool")) return "boolean";
        if (lower.contains("number") || lower.contains("decimal") || lower.contains("double")
                || lower.contains("float") || lower.contains("integer") || lower.endsWith(":int")
                || lower.equals("int") || lower.contains("long") || lower.contains("short")) return "number";
        return "string";
    }

    private static void addAttributeField(List<Object> fields, Element element, String attributeName,
            String sourcePath, String nodePath, String declaredType) {
        if (element == null || !element.hasAttribute(attributeName)) return;
        String label = attributeName;
        if (element.hasAttribute("name") && !"name".equals(attributeName)) {
            label = element.getAttribute("name");
        } else if (!"parameter".equals(localName(element))) {
            label = localName(element) + " " + attributeName;
        }
        String value = element.getAttribute(attributeName);
        fields.add(field(label, value, declaredType == null ? inferType(value) : declaredType,
                sourcePath, nodePath, attributeName));
    }

    private static void addTextField(List<Object> fields, Element element, String sourcePath,
            String label, String declaredType) {
        String value = element.getTextContent().trim();
        fields.add(field(label, value, declaredType == null ? inferType(value) : declaredType,
                sourcePath, elementPath(element), "#text"));
    }

    private static Map<String, Object> field(String label, String value, String type,
            String sourcePath, String nodePath, String attributeName) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("label", label);
        result.put("value", value);
        result.put("type", type);
        result.put("sourcePath", sourcePath);
        result.put("nodePath", nodePath);
        result.put("attribute", attributeName);
        return result;
    }

    private static String inferType(String value) {
        String trimmed = value.trim();
        if ("true".equalsIgnoreCase(trimmed) || "false".equalsIgnoreCase(trimmed)) return "boolean";
        try {
            if (trimmed.length() > 0) {
                new BigDecimal(trimmed);
                return "number";
            }
        } catch (NumberFormatException ignored) {
            // Non-numeric values are strings.
        }
        return "string";
    }

    private static String elementPath(Element element) {
        List<Integer> indices = new ArrayList<Integer>();
        Node current = element;
        while (current != null && current.getNodeType() == Node.ELEMENT_NODE) {
            Node parent = current.getParentNode();
            if (parent == null || parent.getNodeType() == Node.DOCUMENT_NODE) {
                indices.add(Integer.valueOf(0));
                break;
            }
            int index = 0;
            for (Node sibling = parent.getFirstChild(); sibling != null; sibling = sibling.getNextSibling()) {
                if (sibling.getNodeType() != Node.ELEMENT_NODE) continue;
                if (sibling == current) break;
                index++;
            }
            indices.add(Integer.valueOf(index));
            current = parent;
        }
        Collections.reverse(indices);
        StringBuilder result = new StringBuilder();
        for (Integer index : indices) {
            if (result.length() > 0) result.append('/');
            result.append(index.intValue());
        }
        return result.toString();
    }

    private static Element locateElement(Document document, String path) {
        if (path == null || !path.matches("0(?:/[0-9]+)*")) {
            throw new HttpError(400, "Invalid nodePath");
        }
        Element current = document.getDocumentElement();
        String[] parts = path.split("/");
        for (int i = 1; i < parts.length; i++) {
            int wanted;
            try {
                wanted = Integer.parseInt(parts[i]);
            } catch (NumberFormatException error) {
                throw new HttpError(400, "Invalid nodePath");
            }
            int index = 0;
            Element next = null;
            for (Node child = current.getFirstChild(); child != null; child = child.getNextSibling()) {
                if (child.getNodeType() != Node.ELEMENT_NODE) continue;
                if (index++ == wanted) {
                    next = (Element) child;
                    break;
                }
            }
            if (next == null) throw new HttpError(400, "nodePath does not exist");
            current = next;
        }
        return current;
    }

    private String existingReference(String value, Map<String, String> constants) throws IOException {
        if (value == null || value.trim().length() == 0) return null;
        String resolved = resolveConstants(value.trim(), constants);
        try {
            Path file = resolveEditableXml(resolved, true);
            return relativePath(file);
        } catch (HttpError error) {
            return null;
        }
    }

    private List<String> existingReferences(String value, Map<String, String> constants) throws IOException {
        List<String> result = new ArrayList<String>();
        if (value == null) return result;
        for (String part : value.split("[|,]")) {
            String path = existingReference(part, constants);
            if (path != null && !result.contains(path)) result.add(path);
        }
        return result;
    }

    private static String resolveConstants(String value, Map<String, String> constants) {
        String result = value;
        Pattern placeholder = Pattern.compile("\\$\\{([^}]+)\\}|\\$([A-Za-z_][A-Za-z0-9_]*)");
        for (int pass = 0; pass < 12; pass++) {
            Matcher matcher = placeholder.matcher(result);
            StringBuffer replaced = new StringBuffer();
            boolean changed = false;
            while (matcher.find()) {
                String name = matcher.group(1) == null ? matcher.group(2) : matcher.group(1);
                String replacement = constants.get(name);
                if (replacement == null) replacement = matcher.group();
                else changed = true;
                matcher.appendReplacement(replaced, Matcher.quoteReplacement(replacement));
            }
            matcher.appendTail(replaced);
            result = replaced.toString();
            if (!changed) break;
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private static List<String> castStringList(Object value) {
        return value instanceof List ? (List<String>) value : Collections.<String>emptyList();
    }

    private static boolean hasElementChild(Element element) {
        for (Node child = element.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child.getNodeType() == Node.ELEMENT_NODE) return true;
        }
        return false;
    }

    private static void setLeafText(Element element, String value) {
        Node firstText = null;
        for (Node child = element.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child.getNodeType() != Node.TEXT_NODE && child.getNodeType() != Node.CDATA_SECTION_NODE) continue;
            if (firstText == null) {
                firstText = child;
                child.setNodeValue(value);
            } else {
                child.setNodeValue("");
            }
        }
        if (firstText == null) element.appendChild(element.getOwnerDocument().createTextNode(value));
    }

    private static void validateReplacement(String current, String replacement) {
        String type = inferType(current);
        if ("boolean".equals(type) && !("true".equalsIgnoreCase(replacement.trim())
                || "false".equalsIgnoreCase(replacement.trim()))) {
            throw new HttpError(400, "Value must be boolean");
        }
        if ("number".equals(type)) {
            try {
                new BigDecimal(replacement.trim());
            } catch (NumberFormatException error) {
                throw new HttpError(400, "Value must be numeric");
            }
        }
    }

    private static void writeXmlAtomically(Path file, Document document, byte[] original) throws Exception {
        Path temporary = file.resolveSibling("." + file.getFileName() + "." + UUID.randomUUID() + ".tmp");
        try {
            TransformerFactory factory = TransformerFactory.newInstance();
            try {
                factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            } catch (Exception ignored) {
                // Continue with the transformer defaults on older Java 8 implementations.
            }
            setTransformerAttribute(factory, XMLConstants.ACCESS_EXTERNAL_DTD, "");
            setTransformerAttribute(factory, XMLConstants.ACCESS_EXTERNAL_STYLESHEET, "");
            Transformer transformer = factory.newTransformer();
            transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
            transformer.setOutputProperty(OutputKeys.INDENT, "yes");
            String originalText = new String(original, UTF8);
            transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION,
                    originalText.trim().startsWith("<?xml") ? "no" : "yes");
            DocumentType doctype = document.getDoctype();
            if (doctype != null) {
                if (doctype.getPublicId() != null) {
                    transformer.setOutputProperty(OutputKeys.DOCTYPE_PUBLIC, doctype.getPublicId());
                }
                if (doctype.getSystemId() != null) {
                    transformer.setOutputProperty(OutputKeys.DOCTYPE_SYSTEM, doctype.getSystemId());
                }
            }
            try {
                transformer.setOutputProperty("{http://xml.apache.org/xslt}indent-amount", "2");
            } catch (IllegalArgumentException ignored) {
                // Indentation remains implementation-defined.
            }
            OutputStream output = Files.newOutputStream(temporary);
            try {
                transformer.transform(new DOMSource(document), new StreamResult(output));
            } finally {
                output.close();
            }
            try {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING,
                        StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static void setTransformerAttribute(TransformerFactory factory, String name, String value) {
        try {
            factory.setAttribute(name, value);
        } catch (IllegalArgumentException ignored) {
            // Java 8 transformer implementations do not all expose JAXP 1.5 attributes.
        }
    }

    private static void validateXml(String content) throws Exception {
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setXIncludeAware(false);
            factory.setExpandEntityReferences(false);
            setFeature(factory, XMLConstants.FEATURE_SECURE_PROCESSING, true);
            setFeature(factory, "http://xml.org/sax/features/external-general-entities", false);
            setFeature(factory, "http://xml.org/sax/features/external-parameter-entities", false);
            setFeature(factory, "http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
            setAttribute(factory, XMLConstants.ACCESS_EXTERNAL_DTD, "");
            setAttribute(factory, XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            DocumentBuilder builder = factory.newDocumentBuilder();
            builder.setEntityResolver((publicId, systemId) -> new InputSource(new StringReader("")));
            builder.parse(new InputSource(new StringReader(content)));
        } catch (Exception ex) {
            throw new HttpError(400, "Invalid XML: " + safeMessage(ex));
        }
    }

    private static void setFeature(DocumentBuilderFactory factory, String name, boolean value) throws Exception {
        factory.setFeature(name, value);
    }

    private static void setAttribute(DocumentBuilderFactory factory, String name, String value) {
        try {
            factory.setAttribute(name, value);
        } catch (IllegalArgumentException ignored) {
            // Java 8 parsers may not expose the JAXP 1.5 attributes; SAX entity features remain disabled.
        }
    }

    private HttpHandler api(final String method, final ApiAction action) {
        return new SafeHandler() {
            protected void handleSafely(HttpExchange exchange) throws Exception {
                requireMethod(exchange, method);
                sendJson(exchange, 200, action.run(exchange));
            }
        };
    }

    private abstract static class SafeHandler implements HttpHandler {
        public final void handle(HttpExchange exchange) throws IOException {
            try {
                handleSafely(exchange);
            } catch (HttpError error) {
                sendJson(exchange, error.status, singleton("error", error.getMessage()));
            } catch (Exception error) {
                sendJson(exchange, 500, singleton("error", "Internal server error: " + safeMessage(error)));
            } finally {
                exchange.close();
            }
        }
        protected abstract void handleSafely(HttpExchange exchange) throws Exception;
    }

    private interface ApiAction {
        Object run(HttpExchange exchange) throws Exception;
    }

    private static void requireMethod(HttpExchange exchange, String method) throws IOException {
        if (!method.equals(exchange.getRequestMethod())) methodNotAllowed(exchange, method);
    }

    private static void methodNotAllowed(HttpExchange exchange, String allowed) throws IOException {
        exchange.getResponseHeaders().set("Allow", allowed);
        throw new HttpError(405, "Method not allowed");
    }

    private static Map<String, Object> readObject(HttpExchange exchange) throws Exception {
        Object parsed = new JsonParser(readBody(exchange)).parse();
        if (!(parsed instanceof Map)) throw new HttpError(400, "JSON body must be an object");
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) parsed;
        return result;
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        InputStream input = exchange.getRequestBody();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int count;
        while ((count = input.read(buffer)) != -1) {
            total += count;
            if (total > MAX_REQUEST_BYTES) throw new HttpError(413, "Request body is too large");
            output.write(buffer, 0, count);
        }
        return new String(output.toByteArray(), UTF8);
    }

    private static void sendJson(HttpExchange exchange, int status, Object value) throws IOException {
        byte[] bytes = Json.write(value).getBytes(UTF8);
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", "application/json; charset=utf-8");
        headers.set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        OutputStream output = exchange.getResponseBody();
        output.write(bytes);
        output.close();
    }

    private static void sendFile(HttpExchange exchange, Path file) throws IOException {
        byte[] bytes = Files.readAllBytes(file);
        exchange.getResponseHeaders().set("Content-Type", contentType(file));
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(200, bytes.length);
        OutputStream output = exchange.getResponseBody();
        output.write(bytes);
        output.close();
    }

    private static String contentType(Path file) {
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        if (name.endsWith(".html") || name.endsWith(".htm")) return "text/html; charset=utf-8";
        if (name.endsWith(".css")) return "text/css; charset=utf-8";
        if (name.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (name.endsWith(".xml")) return "application/xml; charset=utf-8";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".gif")) return "image/gif";
        if (name.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private static Map<String, String> queryParameters(URI uri) throws Exception {
        Map<String, String> result = new LinkedHashMap<String, String>();
        String query = uri.getRawQuery();
        if (query == null) return result;
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            String key = equals < 0 ? pair : pair.substring(0, equals);
            String value = equals < 0 ? "" : pair.substring(equals + 1);
            result.put(URLDecoder.decode(key, "UTF-8"), URLDecoder.decode(value, "UTF-8"));
        }
        return result;
    }

    private String relativePath(Path file) {
        return "TEST/" + testRoot.relativize(file).toString().replace('\\', '/');
    }

    private String readSelectedEnvironment() throws IOException {
        Properties properties = new Properties();
        Reader reader = Files.newBufferedReader(landscapeConfig, StandardCharsets.ISO_8859_1);
        try {
            properties.load(reader);
        } finally {
            reader.close();
        }
        String configured = properties.getProperty("sap.cc.landscape", "").trim();
        for (Environment environment : environments) {
            if (environment.landscape.equalsIgnoreCase(configured)) return environment.name;
        }
        throw new IOException("Unknown sap.cc.landscape in config.properties: " + configured);
    }

    private String landscapeValue(String displayName) {
        for (Environment environment : environments) {
            if (environment.name.equalsIgnoreCase(displayName)) return environment.landscape;
        }
        throw new HttpError(400, "Unknown environment");
    }

    private String displayEnvironment(String landscape) {
        String value = landscape == null ? "" : landscape.trim();
        if ("QAS".equalsIgnoreCase(value)) return "SQAS";
        for (Environment environment : environments) {
            if (environment.landscape.equalsIgnoreCase(value)) return environment.name;
        }
        return value;
    }

    private void requireKnownEnvironment(String displayName) {
        for (Environment environment : environments) {
            if (environment.name.equals(displayName)) return;
        }
        throw new HttpError(400, "Unknown environment");
    }

    private void writeSelectedEnvironment(String displayName) throws IOException {
        String landscape = landscapeValue(displayName);
        synchronized (environmentWriteLock) {
            List<String> lines = Files.readAllLines(landscapeConfig, StandardCharsets.ISO_8859_1);
            List<String> updated = new ArrayList<String>();
            boolean replaced = false;
            for (String line : lines) {
                if (line.trim().startsWith("sap.cc.landscape=")) {
                    updated.add("sap.cc.landscape=" + landscape);
                    replaced = true;
                } else {
                    updated.add(line);
                }
            }
            if (!replaced) updated.add("sap.cc.landscape=" + landscape);
            Path temporary = landscapeConfig.resolveSibling(
                    "." + landscapeConfig.getFileName() + "." + UUID.randomUUID() + ".tmp");
            try {
                Files.write(temporary, updated, StandardCharsets.ISO_8859_1);
                try {
                    Files.move(temporary, landscapeConfig, StandardCopyOption.REPLACE_EXISTING,
                            StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException ex) {
                    Files.move(temporary, landscapeConfig, StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(temporary);
            }
        }
    }

    private static String requiredString(Map<String, Object> object, String key) {
        Object value = object.get(key);
        if (!(value instanceof String)) throw new HttpError(400, "Missing or invalid " + key);
        return (String) value;
    }

    private static String readTail(Path file) throws IOException {
        if (!Files.isRegularFile(file)) return "";
        byte[] bytes = Files.readAllBytes(file);
        int start = Math.max(0, bytes.length - LOG_TAIL_BYTES);
        while (start < bytes.length && start > 0 && (bytes[start] & 0xC0) == 0x80) start++;
        return new String(bytes, start, bytes.length - start, UTF8);
    }

    private static boolean isSecretKey(String key) {
        String lower = key.toLowerCase(Locale.ROOT);
        String compact = lower.replaceAll("[^a-z0-9]", "");
        return lower.contains("password") || lower.contains("secret") || lower.contains("token")
                || compact.contains("password") || compact.contains("secret") || compact.contains("token")
                || compact.contains("passwd");
    }

    private static boolean isExcludedSuite(String name) {
        return "common".equalsIgnoreCase(name) || "template".equalsIgnoreCase(name);
    }

    private static boolean isSimpleName(String value) {
        return value.length() > 0 && !value.equals(".") && !value.equals("..")
                && value.indexOf('/') < 0 && value.indexOf('\\') < 0
                && value.indexOf('\0') < 0;
    }

    private static Comparator<Path> pathComparator() {
        return new Comparator<Path>() {
            public int compare(Path left, Path right) {
                return left.getFileName().toString().compareToIgnoreCase(right.getFileName().toString());
            }
        };
    }

    private static Path requireDirectory(Path path) throws IOException {
        if (!Files.isDirectory(path)) throw new IOException("Required directory not found: " + path);
        return path.toRealPath();
    }

    private static Path requireFile(Path path) throws IOException {
        if (!Files.isRegularFile(path)) throw new IOException("Required file not found: " + path);
        return path.toRealPath();
    }

    private static Path inferRoot(Path start) throws IOException {
        Path current = start.toAbsolutePath().normalize();
        while (current != null) {
            if (Files.isDirectory(current.resolve("TEST"))
                    && Files.isDirectory(current.resolve(Paths.get("app", "web")))) return current;
            current = current.getParent();
        }
        throw new IOException("Could not infer project root");
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().length() == 0
                ? error.getClass().getSimpleName() : message.replace('\r', ' ').replace('\n', ' ');
    }

    private static Map<String, Object> singleton(String key, Object value) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put(key, value);
        return result;
    }

    private static final class Environment {
        final String name;
        final String landscape;
        final Map<String, String> properties;
        Environment(String name, String landscape, Map<String, String> properties) {
            this.name = name;
            this.landscape = landscape;
            this.properties = properties;
        }
    }

    private static final class RunState {
        volatile boolean running;
        volatile Integer exitCode;
        String target;
        String suite;
        String environment;
        Path log;
    }

    private static final class TargetDefinition {
        final String name;
        final String description;
        final String explicitEnvironment;
        final List<String> suites;
        final Element targetElement;
        final Element runElement;
        TargetDefinition(String name, String description, String explicitEnvironment, List<String> suites,
                Element targetElement, Element runElement) {
            this.name = name;
            this.description = description;
            this.explicitEnvironment = explicitEnvironment;
            this.suites = suites;
            this.targetElement = targetElement;
            this.runElement = runElement;
        }
    }

    private static final class HttpError extends RuntimeException {
        final int status;
        HttpError(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    private static final class Json {
        static String write(Object value) {
            StringBuilder output = new StringBuilder();
            append(output, value);
            return output.toString();
        }

        private static void append(StringBuilder output, Object value) {
            if (value == null) {
                output.append("null");
            } else if (value instanceof String) {
                quote(output, (String) value);
            } else if (value instanceof Number || value instanceof Boolean) {
                output.append(value.toString());
            } else if (value instanceof Map) {
                output.append('{');
                boolean first = true;
                for (Object entryObject : ((Map<?, ?>) value).entrySet()) {
                    Map.Entry<?, ?> entry = (Map.Entry<?, ?>) entryObject;
                    if (!first) output.append(',');
                    first = false;
                    quote(output, String.valueOf(entry.getKey()));
                    output.append(':');
                    append(output, entry.getValue());
                }
                output.append('}');
            } else if (value instanceof Iterable) {
                output.append('[');
                boolean first = true;
                for (Object item : (Iterable<?>) value) {
                    if (!first) output.append(',');
                    first = false;
                    append(output, item);
                }
                output.append(']');
            } else {
                quote(output, String.valueOf(value));
            }
        }

        private static void quote(StringBuilder output, String value) {
            output.append('"');
            for (int i = 0; i < value.length(); i++) {
                char character = value.charAt(i);
                switch (character) {
                    case '"': output.append("\\\""); break;
                    case '\\': output.append("\\\\"); break;
                    case '\b': output.append("\\b"); break;
                    case '\f': output.append("\\f"); break;
                    case '\n': output.append("\\n"); break;
                    case '\r': output.append("\\r"); break;
                    case '\t': output.append("\\t"); break;
                    default:
                        if (character < 0x20) {
                            output.append(String.format("\\u%04x", (int) character));
                        } else {
                            output.append(character);
                        }
                }
            }
            output.append('"');
        }
    }

    private static final class JsonParser {
        private final String input;
        private int position;
        JsonParser(String input) { this.input = input; }

        Object parse() {
            skipWhitespace();
            Object value = value();
            skipWhitespace();
            if (position != input.length()) fail("Unexpected trailing content");
            return value;
        }

        private Object value() {
            skipWhitespace();
            if (position >= input.length()) fail("Unexpected end of JSON");
            char current = input.charAt(position);
            if (current == '"') return string();
            if (current == '{') return object();
            if (current == '[') return array();
            if (current == 't') { literal("true"); return Boolean.TRUE; }
            if (current == 'f') { literal("false"); return Boolean.FALSE; }
            if (current == 'n') { literal("null"); return null; }
            if (current == '-' || Character.isDigit(current)) return number();
            fail("Unexpected character");
            return null;
        }

        private Map<String, Object> object() {
            Map<String, Object> result = new LinkedHashMap<String, Object>();
            position++;
            skipWhitespace();
            if (consume('}')) return result;
            while (true) {
                skipWhitespace();
                if (position >= input.length() || input.charAt(position) != '"') fail("Expected object key");
                String key = string();
                skipWhitespace();
                if (!consume(':')) fail("Expected ':'");
                result.put(key, value());
                skipWhitespace();
                if (consume('}')) return result;
                if (!consume(',')) fail("Expected ','");
            }
        }

        private List<Object> array() {
            List<Object> result = new ArrayList<Object>();
            position++;
            skipWhitespace();
            if (consume(']')) return result;
            while (true) {
                result.add(value());
                skipWhitespace();
                if (consume(']')) return result;
                if (!consume(',')) fail("Expected ','");
            }
        }

        private String string() {
            position++;
            StringBuilder result = new StringBuilder();
            while (position < input.length()) {
                char current = input.charAt(position++);
                if (current == '"') return result.toString();
                if (current == '\\') {
                    if (position >= input.length()) fail("Incomplete escape");
                    char escaped = input.charAt(position++);
                    switch (escaped) {
                        case '"': result.append('"'); break;
                        case '\\': result.append('\\'); break;
                        case '/': result.append('/'); break;
                        case 'b': result.append('\b'); break;
                        case 'f': result.append('\f'); break;
                        case 'n': result.append('\n'); break;
                        case 'r': result.append('\r'); break;
                        case 't': result.append('\t'); break;
                        case 'u':
                            if (position + 4 > input.length()) fail("Incomplete unicode escape");
                            try {
                                result.append((char) Integer.parseInt(input.substring(position, position + 4), 16));
                            } catch (NumberFormatException ex) {
                                fail("Invalid unicode escape");
                            }
                            position += 4;
                            break;
                        default: fail("Invalid escape");
                    }
                } else {
                    if (current < 0x20) fail("Control character in string");
                    result.append(current);
                }
            }
            fail("Unterminated string");
            return null;
        }

        private Number number() {
            int start = position;
            if (consume('-') && position >= input.length()) fail("Invalid number");
            if (position < input.length() && input.charAt(position) == '0') {
                position++;
            } else {
                digits();
            }
            boolean decimal = false;
            if (consume('.')) {
                decimal = true;
                digits();
            }
            if (position < input.length() && (input.charAt(position) == 'e' || input.charAt(position) == 'E')) {
                decimal = true;
                position++;
                if (position < input.length() && (input.charAt(position) == '+' || input.charAt(position) == '-')) position++;
                digits();
            }
            try {
                String token = input.substring(start, position);
                return decimal ? Double.valueOf(token) : Long.valueOf(token);
            } catch (NumberFormatException ex) {
                fail("Invalid number");
                return null;
            }
        }

        private void digits() {
            int start = position;
            while (position < input.length() && Character.isDigit(input.charAt(position))) position++;
            if (start == position) fail("Expected digit");
        }

        private void literal(String expected) {
            if (!input.regionMatches(position, expected, 0, expected.length())) fail("Invalid literal");
            position += expected.length();
        }

        private boolean consume(char expected) {
            if (position < input.length() && input.charAt(position) == expected) {
                position++;
                return true;
            }
            return false;
        }

        private void skipWhitespace() {
            while (position < input.length()) {
                char current = input.charAt(position);
                if (current != ' ' && current != '\t' && current != '\r' && current != '\n') break;
                position++;
            }
        }

        private void fail(String message) {
            throw new HttpError(400, "Invalid JSON at position " + position + ": " + message);
        }
    }
}
