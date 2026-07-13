const report = (value) => {
  if (typeof process.send === 'function') process.send(value);
};

fetch('https://child-escape.example')
  .then(() => report('BYPASS'))
  .catch((error) => report(error?.code || 'UNGUARDED_FAILURE'));
