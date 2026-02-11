import { APIGatewayProxyEventV2 } from 'aws-lambda';

export const parseJsonBody = (event: APIGatewayProxyEventV2): unknown => {
  if (!event.body) {
    return null;
  }

  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error('Invalid JSON body');
  }
};
