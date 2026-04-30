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

function toBoolean(value) {
  return (value === 1 || value === true);
}

module.exports = { convertHoursToString, toBoolean };
