import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class DataSourceApiService {
  private readonly logger = new Logger(DataSourceApiService.name);

  async testDataak(credentials: any, params: any): Promise<any> {
    try {
      // Dataak API integration
      // This is a placeholder - you'll need to implement actual API calls based on Dataak's documentation
      this.logger.log('Testing Dataak API connection');
      
      return {
        status: 'success',
        message: 'Dataak API connection test (placeholder)',
        params,
        note: 'Implement actual Dataak API integration here',
        credentials: {
          username: credentials.username,
          endpoint: 'https://app.dataak.com',
        },
      };
    } catch (error) {
      throw new HttpException(
        `Dataak API Error: ${error.message}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async test8tag(credentials: any, params: any): Promise<any> {
    try {
      this.logger.log('Testing 8tag API connection');
      
      const domain = 'https://d1.8tag.ir';
      
      // Step 1: Login to get JWT token
      const loginResponse = await axios.post(`${domain}/api/v4/login`, {
        username: credentials.username,
        password: credentials.password,
      }, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (loginResponse.data.status !== 200) {
        throw new Error(`Login failed: ${loginResponse.data.error || 'Unknown error'}`);
      }

      const token = loginResponse.data.result;
      this.logger.log('8tag login successful, token acquired');

      // Step 2: Get list of pages
      const pagesResponse = await axios.post(`${domain}/api/v4/pages`, {
        token,
      }, {
        headers: { 'Content-Type': 'application/json' },
      });

      const pages = pagesResponse.data.result || [];
      this.logger.log(`Retrieved ${pages.length} pages from 8tag`);

      if (pages.length === 0) {
        return {
          status: 'success',
          message: 'No pages available',
          data: {
            authentication: 'Token acquired successfully',
            pages: { count: 0, list: [] },
          },
        };
      }

      // Step 3: Select page(s) to query
      // If pageId is provided in params, use it; otherwise use the first page
      let selectedPageIds: number[] = [];
      
      if (params.pageId) {
        selectedPageIds = [parseInt(params.pageId)];
      } else if (params.pageName) {
        // Find page by name
        const matchingPage = pages.find(p => 
          p.name.toLowerCase().includes(params.pageName.toLowerCase())
        );
        if (matchingPage) {
          selectedPageIds = [matchingPage.id];
        }
      }
      
      // If no specific page selected, use first page as default
      if (selectedPageIds.length === 0) {
        selectedPageIds = [pages[0].id];
      }

      // Step 4: Get statistics for the selected page
      const statsPayload: any = {
        token,
        id: selectedPageIds[0], // Statistics endpoint uses single ID
      };

      if (params.startDate) {
        statsPayload.since = Math.floor(new Date(params.startDate).getTime() / 1000);
      }
      if (params.endDate) {
        statsPayload.to = Math.floor(new Date(params.endDate).getTime() / 1000);
      }

      let pageStats: any = null;
      try {
        const statsResponse = await axios.post(`${domain}/api/v4/statistics`, statsPayload, {
          headers: { 'Content-Type': 'application/json' },
        });
        pageStats = statsResponse.data.result;
      } catch (statsError) {
        this.logger.warn(`Could not fetch page statistics: ${statsError.message}`);
      }

      // Step 5: Fetch posts for the selected page with filters
      const postsPayload: any = {
        token,
        id: selectedPageIds[0],
        limit: params.limit || 50,
      };

      // Add date filters
      if (params.startDate) {
        postsPayload.since = Math.floor(new Date(params.startDate).getTime() / 1000);
      }
      if (params.endDate) {
        postsPayload.to = Math.floor(new Date(params.endDate).getTime() / 1000);
      }

      // Add keyword filter if provided
      if (params.keyword) {
        postsPayload.phrase = params.keyword;
      }

      // Add sentiment filters (default to all if not specified)
      postsPayload.positive = params.positive !== false;
      postsPayload.neutral = params.neutral !== false;
      postsPayload.negative = params.negative !== false;

      // Add sorting
      postsPayload.sort = params.sort || 'recent'; // recent, popular, etc.

      let postsData: any = null;
      try {
        const postsResponse = await axios.post(`${domain}/api/v4/posts`, postsPayload, {
          headers: { 'Content-Type': 'application/json' },
        });
        postsData = postsResponse.data.result;
        this.logger.log(`Retrieved ${Array.isArray(postsData) ? postsData.length : 0} posts for page ${selectedPageIds[0]}`);
      } catch (postsError) {
        this.logger.error(`Could not fetch posts: ${postsError.message}`);
        throw postsError;
      }

      // Step 6: Get selected page details
      const selectedPage = pages.find(p => p.id === selectedPageIds[0]);

      return {
        status: 'success',
        message: '8tag API connection successful - Page-specific data retrieved',
        data: {
          authentication: 'Token acquired successfully',
          selectedPage: {
            id: selectedPage?.id,
            name: selectedPage?.name,
            source: selectedPage?.source,
          },
          availablePages: {
            count: pages.length,
            list: pages.slice(0, 10).map(p => ({
              id: p.id,
              name: p.name,
              source: p.source,
            })),
          },
          statistics: pageStats,
          posts: {
            count: Array.isArray(postsData) ? postsData.length : 0,
            data: postsData,
            filters: {
              keyword: params.keyword || null,
              startDate: params.startDate || null,
              endDate: params.endDate || null,
              sentiments: {
                positive: postsPayload.positive,
                neutral: postsPayload.neutral,
                negative: postsPayload.negative,
              },
              sort: postsPayload.sort,
            },
          },
        },
        params,
      };
    } catch (error) {
      this.logger.error(`8tag API Error: ${error.message}`, error.stack);
      
      // Handle specific error codes
      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data;
        
        let errorMessage = '8tag API Error: ';
        switch (status) {
          case 400:
            errorMessage += 'Bad Request - Missing parameters or invalid Content-Type';
            break;
          case 401:
            errorMessage += 'Authentication Failed - Invalid credentials or inactive account';
            break;
          case 403:
            errorMessage += 'Forbidden - Invalid/expired token or no access to resource';
            break;
          case 429:
            errorMessage += 'Rate Limit Reached - Monthly or daily search limits exceeded';
            break;
          case 500:
            errorMessage += 'Internal Server Error - Please contact support';
            break;
          default:
            errorMessage += errorData?.error || error.message;
        }
        
        throw new HttpException(errorMessage, HttpStatus.BAD_REQUEST);
      }
      
      throw new HttpException(
        `8tag API Error: ${error.message}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async testDatami(credentials: any, params: any): Promise<any> {
    try {
      // Datami API integration
      this.logger.log('Testing Datami API connection');
      
      return {
        status: 'success',
        message: 'Datami API connection test (placeholder)',
        params,
        note: 'Implement actual Datami API integration here',
        credentials: {
          username: credentials.username,
          endpoint: 'https://datami.ir',
        },
      };
    } catch (error) {
      throw new HttpException(
        `Datami API Error: ${error.message}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async testMahta(credentials: any, params: any): Promise<any> {
    try {
      // Mahta API integration
      this.logger.log('Testing Mahta API connection');
      
      return {
        status: 'success',
        message: 'Mahta API connection test (placeholder)',
        params,
        note: 'Implement actual Mahta API integration here',
        credentials: {
          username: credentials.username,
          endpoint: 'https://app.mahta.co',
        },
      };
    } catch (error) {
      throw new HttpException(
        `Mahta API Error: ${error.message}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  async list8tagPages(credentials: any): Promise<any> {
    try {
      const domain = 'https://d1.8tag.ir';
      
      // Login to get JWT token
      const loginResponse = await axios.post(`${domain}/api/v4/login`, {
        username: credentials.username,
        password: credentials.password,
      }, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (loginResponse.data.status !== 200) {
        throw new Error(`Login failed: ${loginResponse.data.error || 'Unknown error'}`);
      }

      const token = loginResponse.data.result;

      // Get list of pages
      const pagesResponse = await axios.post(`${domain}/api/v4/pages`, {
        token,
      }, {
        headers: { 'Content-Type': 'application/json' },
      });

      const pages = pagesResponse.data.result || [];

      return {
        status: 'success',
        count: pages.length,
        pages: pages.map(p => ({
          id: p.id,
          name: p.name,
          source: p.source,
        })),
      };
    } catch (error) {
      throw new HttpException(
        `8tag API Error: ${error.message}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
