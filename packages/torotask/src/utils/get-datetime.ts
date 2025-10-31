export function getDateTime(datetime: Date | string | number): number {
  if (datetime instanceof Date) {
    return datetime.getTime();
  }
  else if (typeof datetime === 'string') {
    return new Date(datetime).getTime();
  }
  else if (typeof datetime === 'number') {
    return datetime;
  }
  throw new Error('Invalid date format');
}
