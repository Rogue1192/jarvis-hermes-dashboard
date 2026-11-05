// Meta supplies localized labels on standard contact questions at read-back,
// but rejects those labels when submitting a cloned form.
export function cloneFormQuestions(questions: any[]) {
  return questions.map(question => {
    const { id, ...copy } = question;
    if (copy.type !== 'CUSTOM') delete copy.label;
    return copy;
  });
}