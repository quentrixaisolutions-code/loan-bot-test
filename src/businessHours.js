// Works out whether the business is currently open, using the hours and
// timezone from the business config. No external date library needed - we use
// the built-in Intl API to read the wall-clock time in the business timezone.

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

// Returns { weekday: "monday", minutes: 543 } for "now" in the given timezone,
// where `minutes` is minutes since midnight.
function nowInTimezone(timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday").toLowerCase();
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some environments report midnight as "24"
  const minute = parseInt(get("minute"), 10);

  return { weekday, minutes: hour * 60 + minute };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Given business config, returns a status object describing open/closed and,
// when closed, when the business next opens (as a friendly label).
export function getBusinessStatus(business) {
  const timezone = business.timezone || "America/Jamaica";
  const hours = business.businessHours || {};
  const { weekday, minutes } = nowInTimezone(timezone);

  const today = hours[weekday];
  const isOpen =
    !!today &&
    minutes >= toMinutes(today.open) &&
    minutes < toMinutes(today.close);

  // Find the next day (starting today) that has opening hours we haven't
  // already passed.
  let nextOpenLabel = null;
  const startIndex = DAY_NAMES.indexOf(weekday);
  for (let offset = 0; offset < 8; offset++) {
    const dayName = DAY_NAMES[(startIndex + offset) % 7];
    const day = hours[dayName];
    if (!day) continue;
    const openMin = toMinutes(day.open);
    if (offset === 0 && minutes < openMin) {
      nextOpenLabel = `today at ${day.open}`;
      break;
    }
    if (offset === 1) {
      nextOpenLabel = `tomorrow at ${day.open}`;
      break;
    }
    if (offset > 1) {
      const nice = dayName.charAt(0).toUpperCase() + dayName.slice(1);
      nextOpenLabel = `${nice} at ${day.open}`;
      break;
    }
  }

  const localTime = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date());

  return { isOpen, nextOpenLabel, localTime, timezone };
}
