export const assertClassRegistrationOpen = (registrationClosed: boolean): void => {
  if (registrationClosed) {
    throw new Error('CLASS_REGISTRATION_CLOSED');
  }
};
