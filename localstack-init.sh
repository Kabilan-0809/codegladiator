#!/bin/bash
echo "Initializing LocalStack resources..."

# Create S3 bucket
awslocal s3 mb s3://codegladiator-submissions

# Create SQS queues
awslocal sqs create-queue --queue-name execution-queue
awslocal sqs create-queue --queue-name match-queue

echo "LocalStack initialization complete!"
