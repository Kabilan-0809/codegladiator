import { ApolloClient, InMemoryCache, createHttpLink, ApolloLink } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { getToken, setToken } from './auth';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/graphql';

const httpLink = createHttpLink({ uri: API_URL });

const authLink = setContext((_, { headers }) => {
  const token = getToken();
  return {
    headers: {
      ...headers,
      authorization: token ? `Bearer ${token}` : '',
    },
  };
});

// Afterware to capture X-Auth-Token from responses
const afterwareLink = new ApolloLink((operation, forward) => {
  return forward(operation).map((response) => {
    const context = operation.getContext();
    const responseHeaders = context.response?.headers;
    if (responseHeaders) {
      const newToken = responseHeaders.get('X-Auth-Token');
      if (newToken) {
        setToken(newToken);
      }
    }
    return response;
  });
});

export const apolloClient = new ApolloClient({
  link: ApolloLink.from([authLink, afterwareLink, httpLink]),
  cache: new InMemoryCache(),
  defaultOptions: {
    watchQuery: { fetchPolicy: 'cache-and-network' },
  },
});
