//+------------------------------------------------------------------+
//|                                          TradeListaTestPing.mq4    |
//| One-off test: sends a single fake trade to TradeLista's           |
//| ingest-trade endpoint, so you can verify the WebRequest/API-key   |
//| setup works without needing a real market trade or open hours.   |
//| Run it once (drag onto a chart from Navigator > Scripts), then    |
//| check the "Experten"/"Journal" tab at the bottom of MT4 for the   |
//| result, and delete the test trade from TradeLista afterwards.    |
//+------------------------------------------------------------------+
#property strict
#property script_show_inputs

input string ApiKey = ""; // TradeLista account API key (Account settings > Trading accounts)

string TimeToStringDate(datetime t)
{
   string s = TimeToString(t, TIME_DATE); // "2026.07.19"
   StringReplace(s, ".", "-");            // -> "2026-07-19"
   return s;
}

void OnStart()
{
   if(StringLen(ApiKey) == 0)
   {
      Alert("TradeListaTestPing: please set ApiKey in the script's Inputs before running.");
      return;
   }

   string json = StringFormat(
      "{\"api_key\":\"%s\",\"symbol\":\"TESTFROMMT4\",\"lot\":0.01,\"entry\":1.10000,\"exit\":1.10500,\"profit\":1.23,\"date\":\"%s\"}",
      ApiKey, TimeToStringDate(TimeCurrent())
   );

   char postData[];
   int written = StringToCharArray(json, postData, 0, StringLen(json));
   if(written > 0 && postData[written-1] == 0)
      ArrayResize(postData, written - 1);
   else
      ArrayResize(postData, written);

   char responseData[];
   string responseHeaders;
   int status = WebRequest("POST", "https://xkmpknoughjnxalkoatx.supabase.co/functions/v1/ingest-trade",
                            "Content-Type: application/json\r\n", 5000, postData, responseData, responseHeaders);

   if(status == -1)
      Alert("TradeListaTestPing FAILED: WebRequest error ", GetLastError(),
            " — check the URL is whitelisted in Tools > Options > Expert Advisors.");
   else if(status >= 400)
      Alert("TradeListaTestPing: server rejected it (HTTP ", status, "): ", CharArrayToString(responseData));
   else
      Alert("TradeListaTestPing OK! HTTP ", status, " — check TradeLista now for a TESTFROMMT4 trade.");
}
