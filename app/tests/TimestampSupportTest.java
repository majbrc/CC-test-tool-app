import java.time.Instant;
import java.util.Map;
import java.util.TimeZone;

public final class TimestampSupportTest {
    private TimestampSupportTest() {
    }

    public static void main(String[] args) {
        testWinterAndSummer();
        testRoundTripAndNegativeEpoch();
        testDaylightSavingTransitions();
        testInvalidInputs();
        testHostZoneIndependence();
        System.out.println("TimestampSupportTest passed");
    }

    private static void testWinterAndSummer() {
        Map<String, Object> winter = TimestampSupport.describe("1705314030123");
        assertEquals("2024-01-15T12:20:30.123", winter.get("localDateTime"));
        assertEquals("+02:00", winter.get("offset"));
        assertEquals("Europe/Vilnius", winter.get("zone"));
        assertEquals("1705314030123", winter.get("epochMillis"));

        Map<String, Object> summer = TimestampSupport.describe("1721038830987");
        assertEquals("2024-07-15T13:20:30.987", summer.get("localDateTime"));
        assertEquals("+03:00", summer.get("offset"));
        assertEquals("1721038830987", summer.get("epochMillis"));
    }

    private static void testRoundTripAndNegativeEpoch() {
        Map<String, Object> converted = TimestampSupport.convert("2024-01-15T12:20:30.123", "+02:00");
        assertEquals("1705314030123", converted.get("epochMillis"));
        assertEquals("2024-01-15T12:20:30.123", converted.get("localDateTime"));

        Map<String, Object> beforeEpoch = TimestampSupport.describe("-1");
        assertEquals("-1", beforeEpoch.get("epochMillis"));
        assertEquals("1970-01-01T02:59:59.999", beforeEpoch.get("localDateTime"));
        assertEquals(Long.toString(Instant.ofEpochMilli(-1L).toEpochMilli()), beforeEpoch.get("epochMillis"));
    }

    private static void testDaylightSavingTransitions() {
        expectIllegalArgument(new Action() {
            @Override
            public void run() {
                TimestampSupport.convert("2024-03-31T03:30:00.123", null);
            }
        }, "does not exist");

        expectIllegalArgument(new Action() {
            @Override
            public void run() {
                TimestampSupport.convert("2024-10-27T03:30:00.123", null);
            }
        }, "+03:00");

        Map<String, Object> summerOccurrence =
                TimestampSupport.convert("2024-10-27T03:30:00.123", "+03:00");
        Map<String, Object> winterOccurrence =
                TimestampSupport.convert("2024-10-27T03:30:00.123", "+02:00");
        assertEquals(Long.toString(Instant.parse("2024-10-27T00:30:00.123Z").toEpochMilli()),
                summerOccurrence.get("epochMillis"));
        assertEquals(Long.toString(Instant.parse("2024-10-27T01:30:00.123Z").toEpochMilli()),
                winterOccurrence.get("epochMillis"));
        assertEquals("+03:00", summerOccurrence.get("offset"));
        assertEquals("+02:00", winterOccurrence.get("offset"));
    }

    private static void testInvalidInputs() {
        expectIllegalArgument(new Action() {
            @Override
            public void run() {
                TimestampSupport.describe("9007199254740993.0");
            }
        }, "integer");
        expectIllegalArgument(new Action() {
            @Override
            public void run() {
                TimestampSupport.describe("9223372036854775808");
            }
        }, "range");
        expectIllegalArgument(new Action() {
            @Override
            public void run() {
                TimestampSupport.describe("");
            }
        }, "integer");
        expectIllegalArgument(new Action() {
            @Override
            public void run() {
                TimestampSupport.convert("2024-02-30T12:00:00.000", null);
            }
        }, "Invalid local date/time");
        expectIllegalArgument(new Action() {
            @Override
            public void run() {
                TimestampSupport.convert("0000-01-01T12:00:00.000", null);
            }
        }, "year");
        expectIllegalArgument(new Action() {
            @Override
            public void run() {
                TimestampSupport.convert("2024-01-15T12:20:30.123", "+03:00");
            }
        }, "not valid");
        expectIllegalArgument(new Action() {
            @Override
            public void run() {
                TimestampSupport.convert("2024-01-15T12:20:30.123", "not-an-offset");
            }
        }, "Invalid offset");
        expectIllegalArgument(new Action() {
            @Override
            public void run() {
                TimestampSupport.convert("2024-10-27T03:30:00.000", "");
            }
        }, "+03:00");
    }

    private static void testHostZoneIndependence() {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Pacific/Honolulu"));
            Map<String, Object> honolulu = TimestampSupport.describe("1721038830987");
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Tokyo"));
            Map<String, Object> tokyo = TimestampSupport.describe("1721038830987");
            assertEquals(honolulu.get("localDateTime"), tokyo.get("localDateTime"));
            assertEquals(honolulu.get("offset"), tokyo.get("offset"));
            assertEquals(honolulu.get("zone"), tokyo.get("zone"));
        } finally {
            TimeZone.setDefault(original);
        }
    }

    private static void expectIllegalArgument(Action action, String messagePart) {
        try {
            action.run();
            throw new AssertionError("Expected IllegalArgumentException containing: " + messagePart);
        } catch (IllegalArgumentException exception) {
            if (!exception.getMessage().contains(messagePart)) {
                throw new AssertionError("Expected message containing '" + messagePart + "', got: "
                        + exception.getMessage(), exception);
            }
        }
    }

    private static void assertEquals(Object expected, Object actual) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError("Expected <" + expected + "> but got <" + actual + ">");
        }
    }

    private interface Action {
        void run();
    }
}
