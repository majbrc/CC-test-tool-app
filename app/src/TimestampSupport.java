import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.time.zone.ZoneRules;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class TimestampSupport {
    private static final ZoneId ZONE = ZoneId.of("Europe/Vilnius");
    private static final DateTimeFormatter LOCAL_FORMAT =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS")
                    .withResolverStyle(ResolverStyle.STRICT);

    private TimestampSupport() {
    }

    public static Map<String, Object> describe(String epochMillis) {
        long millis = parseEpochMillis(epochMillis);
        try {
            LocalDateTime localDateTime = LocalDateTime.ofInstant(Instant.ofEpochMilli(millis), ZONE);
            requireSupportedYear(localDateTime);

            Map<String, Object> result = new LinkedHashMap<String, Object>();
            result.put("epochMillis", Long.toString(millis));
            result.put("localDateTime", LOCAL_FORMAT.format(localDateTime));
            result.put("offset", ZONE.getRules().getOffset(Instant.ofEpochMilli(millis)).getId());
            result.put("zone", ZONE.getId());
            return Collections.unmodifiableMap(result);
        } catch (DateTimeException exception) {
            throw new IllegalArgumentException("Epoch milliseconds are outside the supported date range", exception);
        }
    }

    public static Map<String, Object> convert(String localDateTime, String offset) {
        if (localDateTime == null || localDateTime.length() == 0) {
            throw new IllegalArgumentException("Local date/time is required");
        }

        final LocalDateTime parsed;
        try {
            parsed = LocalDateTime.parse(localDateTime, LOCAL_FORMAT);
            requireSupportedYear(parsed);
        } catch (DateTimeException exception) {
            throw new IllegalArgumentException(
                    "Invalid local date/time; expected yyyy-MM-dd'T'HH:mm:ss.SSS in years 0001 through 9999",
                    exception);
        }

        ZoneRules rules = ZONE.getRules();
        List<ZoneOffset> validOffsets = rules.getValidOffsets(parsed);
        if (validOffsets.isEmpty()) {
            throw new IllegalArgumentException(
                    "Local date/time does not exist in Europe/Vilnius because of the daylight-saving transition");
        }

        String requestedOffset = offset == null || offset.length() == 0 ? null : offset;
        ZoneOffset selectedOffset;
        if (requestedOffset == null) {
            if (validOffsets.size() > 1) {
                throw new IllegalArgumentException(
                        "Local date/time is ambiguous in Europe/Vilnius; specify one of the permitted offsets: "
                                + formatOffsets(validOffsets));
            }
            selectedOffset = validOffsets.get(0);
        } else {
            final ZoneOffset candidate;
            try {
                candidate = ZoneOffset.of(requestedOffset);
            } catch (DateTimeException exception) {
                throw new IllegalArgumentException("Invalid offset: " + requestedOffset, exception);
            }
            if (!validOffsets.contains(candidate)) {
                throw new IllegalArgumentException(
                        "Offset " + requestedOffset + " is not valid for this local date/time in Europe/Vilnius; "
                                + "permitted offsets: " + formatOffsets(validOffsets));
            }
            selectedOffset = candidate;
        }

        long millis;
        try {
            millis = parsed.toInstant(selectedOffset).toEpochMilli();
        } catch (DateTimeException | ArithmeticException exception) {
            throw new IllegalArgumentException("Local date/time is outside the supported epoch range", exception);
        }
        return describe(Long.toString(millis));
    }

    private static long parseEpochMillis(String value) {
        if (value == null || !value.matches("-?(0|[1-9][0-9]*)")) {
            throw new IllegalArgumentException("Epoch milliseconds must be a base-10 integer string");
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException("Epoch milliseconds are outside the signed 64-bit range", exception);
        }
    }

    private static void requireSupportedYear(LocalDateTime value) {
        int year = value.getYear();
        if (year < 1 || year > 9999) {
            throw new IllegalArgumentException("Date/time year must be between 0001 and 9999");
        }
    }

    private static String formatOffsets(List<ZoneOffset> offsets) {
        List<String> values = new ArrayList<String>(offsets.size());
        for (ZoneOffset offset : offsets) {
            values.add(offset.getId());
        }
        return values.toString();
    }
}
