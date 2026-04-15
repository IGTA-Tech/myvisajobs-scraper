/**
 * Exact column order of the IA_Employer_Leads sheet.
 * Must match the Apps Script getAllColumnIndices() output 1:1.
 */
export const LEAD_COLUMNS: string[] = (() => {
  const cols: string[] = [
    "Employer_ID", "Date_Added", "Timestamp", "Company_Name", "Company_Name_Variations",
    "MyVisaJobs_URL", "Company_Website", "LinkedIn_Company_URL", "Verification_Status", "Data_Source",
    "Main_Office_Address", "Main_Office_City", "Main_Office_State", "Main_Office_Zip", "Founded_Year",
    "NAICS_Industry", "Industry_Category", "Company_Size_Employees", "H1B_Dependent_Status", "Willful_Violator_Status",
    "Visa_Rank", "Total_H1B_LCAs_3yr", "Total_GC_LCs_3yr", "Total_Denied_Withdrawn_3yr",
    "H1B_LCA_Current_Year", "H1B_LCA_Last_Year", "H1B_LCA_2_Years_Ago",
    "GC_LC_Current_Year", "GC_LC_Last_Year", "GC_LC_2_Years_Ago",
    "H1B_Approval_Rate_Current", "H1B_Approval_Rate_Historical", "Sponsorship_Trend",
    "Avg_H1B_Salary_Current", "Avg_GC_Salary_Current",
    "Top_Sponsored_Role_1", "Top_Sponsored_Role_1_Count", "Top_Sponsored_Role_2", "Top_Sponsored_Role_2_Count",
    "Top_Sponsored_Role_3", "Top_Sponsored_Role_3_Count", "Other_Sponsored_Roles", "Top_Worker_Countries", "Sponsor_O1_Visas",
  ];
  for (let i = 1; i <= 10; i++) {
    cols.push(
      `Contact_${i}_Name`,
      `Contact_${i}_Title`,
      `Contact_${i}_Email`,
      `Contact_${i}_Phone`,
      `Contact_${i}_Type`,
      `Contact_${i}_LinkedIn`,
    );
  }
  cols.push(
    "Office_Locations_Count", "Top_H1B_Work_Sites", "Top_GC_Work_Sites", "All_Office_Locations", "International_Offices",
    "AI_Employer_Score", "Evaluation_Date", "Sponsorship_Likelihood", "Target_Priority", "Best_Visa_Types",
    "Candidate_Match_Potential", "Partnership_Opportunity", "Decision_Maker_Accessibility", "AI_Evaluation_Notes",
    "Lead_Status", "Lead_Temperature", "Assigned_To", "First_Contact_Date", "Last_Contact_Date",
    "Next_Follow_Up", "Contact_Attempts", "Contacts_Reached", "Primary_Contact_Person",
    "Meeting_Scheduled", "Meeting_Completed", "Partnership_Status", "Contract_Signed",
    "Revenue_Potential", "Candidates_Placed", "Active_Opportunities",
    "Email_Opens", "Email_Clicks", "Last_Email_Sent", "SMS_Sent", "Call_Notes",
    "Review_Count", "Average_Review_Score", "Positive_Review_Keywords", "Negative_Review_Keywords", "Immigration_Support_Rating",
    "Internal_Notes", "Conversation_History", "Red_Flags", "Green_Flags", "Partnership_Probability",
    "Data_Quality_Score", "Last_Updated", "Updated_By", "Tags",
    "Message_Subject", "Message_Body", "Generated_Date", "Message_Status", "Sent_Date", "Message_Response_Received",
    // New discovery metadata columns (positions 160/161, letters FD/FE).
    // Must be added manually as headers in row 1 of IA_Employer_Leads before first run.
    "Discovery_Source", "Discovery_Notes",
  );
  return cols;
})();

export function colIndex(name: string): number {
  const i = LEAD_COLUMNS.indexOf(name);
  if (i < 0) throw new Error(`Unknown column: ${name}`);
  return i;
}
