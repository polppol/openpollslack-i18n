function convertHoursToString(hourNumber) {
  // Extract whole hours
  let hours = Math.floor(hourNumber);

  // Convert fractional hours to minutes
  let minutes = Math.round((hourNumber - hours) * 60);

  // Adjust for when minutes round to 60
  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }

  // Format the string
  return `${hours}:${minutes.toString().padStart(2, '0')}`;
}

// Permissive boolean coercion that accepts the JS booleans, the number 1,
// and common string forms ("true"/"1"/"yes", case-insensitive). Used across
// config-override paths where a value may have been hand-edited into
// MongoDB or arrived from a future serialiser that round-trips JSON
// booleans as strings. Anything else returns false (so undefined / null /
// 0 / "false" / "no" / arbitrary strings all coerce to false safely).
function toBoolean(value) {
  if (value === 1 || value === true) return true;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

module.exports = { convertHoursToString, toBoolean };
