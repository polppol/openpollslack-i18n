function isValidISO8601(inputTS) {
  // Regular expression to check ISO 8601 format
  const regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(.\d+)?([+-]\d{2}:\d{2}|Z)?$/;

  if (regex.test(inputTS)) {
    // Check if the date is valid
    const date = new Date(inputTS);
    return !isNaN(date.getTime());
  } else {
    return false;
  }
}

module.exports = { isValidISO8601 };
